// -----------------------------------------------------------------------------
// NexiaApp: the integration. One account (Nexia, Trane Home or American
// Standard Home), the thermostats of its house and their zones.
//
//   start(config)  (re)connects: sign in, the house read, Discovery
//                  published, the reading loop started. The same
//                  configuration again (Gladys reconnected) publishes the
//                  status, Discovery and the states again: the client (and
//                  its session), a refusal and an HTTP 429 pause stay.
//   reading loop   every 60 s: the house (If-None-Match: a 304 costs
//                  nothing). The cloud unreachable: retried 60 s to 30 min
//                  (never faster than the reading); HTTP 429: a pause of
//                  1 min to 6 h for every request, kept in /data.
//   setValue       setpoints, zone mode, fan mode: see "Commands" below.
//
// The e-mail or the password refused: the integration stops; it tries again
// by itself twice (6 h, then 24 h later, kept in /data), then waits for the
// user (configuration saved, or "Test the connection").
//
// Each loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch never schedules itself again.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { accountKey, normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  INTERVALS,
  LIMITS,
  REFUSED_RETRIES_MS,
  SETPOINT_BOUNDS,
  SETPOINT_STEP,
  THERMOSTAT_FEATURES as TF,
  ZONE_FEATURES as ZF,
} from './constants.js';
import {
  MODE_OF_VALUE,
  buildThermostatDevice,
  buildZoneDevice,
  convert,
  convertExact,
  createdDevices,
  fanOptions,
  mergeWithCreated,
  nexiaUnit,
  parseExternalId,
  thermostatIds,
  thermostatStates,
  unitSymbol,
  zoneIds,
  zoneStates,
} from './devices.js';
import { T } from './i18n.js';
import { NexiaClient } from './nexia/client.js';
import { CODES, isRateLimited, isRefused } from './nexia/errors.js';
import { httpRequest } from './nexia/http.js';
import { deviceItemsOf, thermostatsOf } from './nexia/model.js';
import { fileStore, normalizeState } from './store.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const EPSILON = 1e-6;

/** A user-facing refusal of a command (its message is shown by Gladys). */
class CommandError extends Error {}

export class NexiaApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake cloud)
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {{ load: Function, save: Function }} [options.store] what survives a restart (/data)
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'nexia' }),
    request = httpRequest,
    now = Date.now,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = store;
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
    this.budgetCursor = 0;
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.configKey = null;
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.readHandle = null;
    this.queue = Promise.resolve();
    /** One account: the commands run one after the other. */
    this.commands = Promise.resolve();
    this.activeCommands = 0;
    /** The request of a command still in flight after its answer to Gladys, or null. */
    this.inFlight = null;
    this.stateVersion = 0;
    this.lastStatus = null;
    /** What survives a restart (store.js), loaded once. */
    this.state = null;
    this.logged = new Set();
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    /** No reading starts before this time (the interval, or the retry delay). */
    this.nextReadAt = 0;
    this.thermostats = [];
    this.discoveredKey = null;
    this.transports = new Map();
  }

  logOnce(key, level, message) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.logger[level](message);
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a refusal of the credentials is
   * forgotten and they are tried again. An HTTP 429 pause stays.
   */
  start(rawConfig, { force = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Gladys went away: the loop stops, everything else (client, refusal, pause) stays. */
  pause() {
    this.halt();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
    this.readHandle = null;
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async loadState() {
    if (this.state) return;
    let raw;
    try {
      raw = await this.store.load();
    } catch {
      raw = null; // unreadable: a fresh state
    }
    this.state = normalizeState(raw, this.now());
    if (raw?.deviceUuid !== this.state.deviceUuid) await this.saveState();
  }

  async saveState() {
    try {
      await this.store.save({
        deviceUuid: this.state.deviceUuid,
        pausedUntil: this.state.pausedUntil,
        refusal: this.state.refusal,
      });
    } catch (err) {
      this.logOnce(
        'store',
        'warn',
        `/data not writable (${err?.code ?? 'error'}): pauses and refusals are kept in memory only`,
      );
    }
  }

  async run(rawConfig, { force = false } = {}) {
    await this.loadState();
    const config = normalizeConfig(rawConfig);
    const key = JSON.stringify(config);
    if (!force && this.client && key === this.configKey && !this.blocked) {
      await this.resume();
      return;
    }
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    this.config = config;
    this.configKey = key;
    this.reset();
    this.lastStatus = null;
    this.gladys.forgetPublishedStates?.();

    if (config.missing.length > 0) {
      await this.setStatus(false, T.status.notConfigured);
      return;
    }
    if (config.emailInvalid) {
      await this.setStatus(false, T.status.emailInvalid);
      return;
    }
    const account = accountKey(config);
    const refusal = this.state.refusal;
    const since = this.now() - (refusal?.at ?? -Infinity);
    if (force && refusal?.account === account && since < INTERVALS.FORCED_LOGIN_SPACING_MS) {
      // A refusal moments ago: the user's try waits a little (a quick series
      // of wrong passwords may lock the account).
      const wait = INTERVALS.FORCED_LOGIN_SPACING_MS - since;
      this.blocked = true;
      await this.setStatus(false, T.status.refusedRecently(wait));
      this.schedule(wait, () =>
        generation === this.generation ? this.start(this.rawConfig, { force: true }) : undefined,
      );
      return;
    }
    if (refusal && (force || refusal.account !== account)) {
      // The user asked, or another account: the old refusal does not apply.
      this.state.refusal = null;
      await this.saveState();
    } else if (refusal && (refusal.nextAt === null || this.now() < refusal.nextAt)) {
      this.blocked = true;
      await this.reportRefusal(generation);
      return;
    }
    this.client = new NexiaClient({
      brand: config.brand,
      email: config.email,
      password: config.password,
      deviceUuid: this.state.deviceUuid,
      request: this.request,
      now: this.now,
    });
    this.logger.info(`Using the ${config.brand} cloud`);
    if (this.paused()) {
      const delay = this.state.pausedUntil - this.now();
      await this.setStatus(false, T.status.busy(delay));
      this.scheduleRead(delay, generation);
      return;
    }
    await this.setStatus(false, T.status.connecting);
    await this.read(generation, this.epoch, { publish: true });
  }

  /** The refusal status, and the automatic try when one is left. */
  async reportRefusal(generation) {
    const nextAt = this.state.refusal?.nextAt ?? null;
    const nextIn = nextAt === null ? null : Math.max(0, nextAt - this.now());
    // Automatic tries left, this next one included.
    const left = Math.max(0, REFUSED_RETRIES_MS.length - (this.state.refusal?.tries ?? 1) + 1);
    await this.setStatus(false, T.status.refused(nextIn, left));
    if (nextIn !== null) {
      this.schedule(nextIn, () =>
        generation === this.generation ? this.start(this.rawConfig) : undefined,
      );
    }
  }

  /**
   * Gladys reconnected with the same configuration: the status, Discovery and
   * the states are published again (Gladys keeps them in memory and may have
   * lost them), the reading loop goes on where it was.
   */
  async resume() {
    this.halt();
    const generation = this.generation;
    const status = this.lastStatus ? JSON.parse(this.lastStatus) : null;
    this.lastStatus = null;
    this.transports.clear();
    this.discoveredKey = null;
    this.gladys.forgetPublishedStates?.();
    if (status) await this.setStatus(status[0], status[1]);
    if (this.thermostats.length > 0) await this.publishDiscovered();
    await this.publishStates();
    await this.publishTransports();
    if (this.client && !this.blocked) {
      const wait = Math.max(this.nextReadAt, this.state.pausedUntil) - this.now();
      this.scheduleRead(Math.max(0, wait), generation);
    }
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      if (this.readHandle === handle) this.readHandle = null;
      try {
        await task();
      } catch (err) {
        this.logger.error(`Loop failed: ${err?.message ?? 'error'}`);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** The next reading (one at a time: a new one replaces the one planned). */
  scheduleRead(delay, generation = this.generation) {
    if (this.readHandle !== null) {
      this.timers.clearTimeout(this.readHandle);
      this.handles.delete(this.readHandle);
    }
    const epoch = this.epoch;
    this.readHandle = this.schedule(delay, () => this.read(generation, epoch, { publish: false }));
  }

  /** May a loop of this generation and epoch go on? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  paused() {
    return this.now() < (this.state?.pausedUntil ?? 0);
  }

  /** One round of the reading loop. Never throws. */
  async read(generation, epoch, { publish }) {
    if (!this.client || !this.current(generation, epoch)) return;
    if (this.paused()) {
      this.scheduleRead(this.state.pausedUntil - this.now(), generation);
      return;
    }
    this.nextReadAt = this.now() + INTERVALS.POLL_MS;
    try {
      await this.refresh({ publish });
    } catch (err) {
      // A round halted meanwhile (Gladys away, new configuration) schedules
      // nothing: the next start or resume reads again.
      if (generation === this.generation && epoch === this.epoch)
        await this.failed(err, generation);
      else this.online = false;
      return;
    }
    if (this.current(generation, epoch)) {
      this.scheduleRead(Math.max(0, this.nextReadAt - this.now()), generation);
    }
  }

  /** A reading failed: a refusal, a pause, or a retry with a growing delay. */
  async failed(err, generation) {
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (isRefused(err)) {
      await this.refused(generation);
      return;
    }
    let delay;
    let message;
    if (isRateLimited(err)) {
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MAX_MS,
      );
      await this.pauseAll(delay);
      message = T.status.busy(delay);
    } else if (err?.code === CODES.SESSION) {
      delay = Math.max(INTERVALS.POLL_MS, (err.retryAt ?? 0) - this.now());
      // With a status: refused just after a sign-in; without: the spacing of
      // the sign-ins is not over yet.
      message = err.status ? T.status.session(delay) : T.status.loginWait(delay);
    } else {
      // A sign-in whose answer could not be used sets its own wait (retryAt).
      delay = Math.max(this.retryDelay, (err?.retryAt ?? 0) - this.now());
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
      message = T.status.unreachable(err, delay);
    }
    this.nextReadAt = this.now() + delay;
    if (wasOnline || delay === INTERVALS.RETRY_MIN_MS || isRateLimited(err)) {
      // Our own message: a code or an HTTP status, never the text of an answer.
      this.logger.warn(`The cloud fails: ${err?.code ?? 'error'} ${err?.status ?? ''}`.trim());
    }
    await this.setStatus(false, message);
    this.scheduleRead(delay, generation);
  }

  /** HTTP 429 met on any path: every request waits, across restarts too. */
  async pauseAll(delay) {
    this.state.pausedUntil = Math.max(this.state.pausedUntil, this.now() + delay);
    await this.saveState();
  }

  /** The e-mail or the password refused: stop, with a bounded number of automatic tries. */
  async refused(generation) {
    this.blocked = true;
    this.dropClient();
    const account = accountKey(this.config);
    const previous = this.state.refusal?.account === account ? this.state.refusal.tries : 0;
    const tries = previous + 1;
    const wait = REFUSED_RETRIES_MS[tries - 1];
    this.state.refusal = {
      account,
      tries,
      at: this.now(),
      nextAt: wait === undefined ? null : this.now() + wait,
    };
    await this.saveState();
    this.logger.warn(
      `The cloud refused the e-mail or the password (try ${tries}): ${
        wait === undefined
          ? 'not tried again until the configuration changes'
          : `next try in ${Math.round(wait / 3600_000)} h`
      }`,
    );
    await this.reportRefusal(generation);
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading -------------------------------------------------------------------

  /** The house read into this.thermostats, the reasons of the left-out ones logged once. */
  apply(json) {
    const { thermostats, skipped } = thermostatsOf(json);
    for (const { skipped: reason, id, name } of skipped) {
      this.logOnce(
        `skipped:${id ?? '?'}:${reason}`,
        'info',
        `Thermostat ${name ? `"${name}" ` : ''}left out: ${
          { id: 'unusable id', unit: 'unknown temperature unit', zones: 'no zone' }[reason] ??
          reason
        }`,
      );
    }
    this.thermostats = thermostats;
  }

  /**
   * Read the house and publish. Resolves false when the reading was dropped
   * (a command ran meanwhile: its result is newer). Throws on any failure.
   */
  async refresh({ publish }) {
    const client = this.client;
    if (!client) return true;
    const version = this.stateVersion;
    const { json } = await client.house();
    if (client !== this.client) return true;
    if (version !== this.stateVersion || this.activeCommands > 0) return false;
    this.apply(json);
    this.online = true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    if (this.state.refusal) {
      this.state.refusal = null;
      await this.saveState();
    }
    const devices = this.discoveryDevices();
    const key = JSON.stringify(devices);
    if (publish || key !== this.discoveredKey) await this.publishDiscovered(devices);
    this.discoveredKey = key;
    await this.publishStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
    return true;
  }

  okMessage() {
    if (this.thermostats.length === 0) return T.status.noThermostat;
    return T.status.ok({
      thermostats: this.thermostats.length,
      zones: this.thermostats.reduce((n, t) => n + t.zones.length, 0),
      offline: this.thermostats.filter((t) => !t.connected).length,
    });
  }

  /** The devices of Discovery; those the user created keep every feature they have. */
  discoveryDevices() {
    const created = createdDevices(this.gladys);
    const { language, brand } = this.config;
    const devices = [];
    for (const thermostat of this.thermostats) {
      const device = buildThermostatDevice(this.gladys, thermostat, language, brand);
      devices.push(mergeWithCreated(device, created.get(device.external_id)));
      for (const zone of thermostat.zones) {
        const zoneDevice = buildZoneDevice(this.gladys, thermostat, zone, language);
        devices.push(mergeWithCreated(zoneDevice, created.get(zoneDevice.external_id)));
      }
    }
    return devices;
  }

  /** Never throws: a refusal of Gladys is not a failure of the cloud. */
  async publishDiscovered(devices = this.discoveryDevices()) {
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.online && this.client && !this.blocked && !this.paused()) {
      const generation = this.generation;
      const applied = await this.refresh({ publish: true }).catch(async (err) => {
        if (isRefused(err) || isRateLimited(err)) await this.failed(err, generation);
        return false;
      });
      if (applied) return;
    }
    if (this.thermostats.length > 0) await this.publishDiscovered();
  }

  /**
   * The states of the created devices, each value converted to the unit of
   * the feature as it was created. Nothing for a thermostat the cloud
   * reports offline (its values would be stale).
   */
  states() {
    const created = createdDevices(this.gladys);
    const out = [];
    const push = (ids, device, list, unit) => {
      for (const [key, value, temperature] of list) {
        const id = ids.feature(key);
        const feature = device.features?.find((f) => f.external_id === id);
        if (!feature) continue;
        if (value.text !== undefined) {
          out.push({ device_feature_external_id: id, text: value.text });
          continue;
        }
        let state = value.state;
        if (temperature) {
          const target = nexiaUnit(feature.unit);
          if (!target) continue;
          state = convert(state, unit, target);
        }
        if (state !== null && Number.isFinite(state)) {
          out.push({ device_feature_external_id: id, state });
        }
      }
    };
    for (const thermostat of this.thermostats) {
      if (!thermostat.connected) continue;
      const ids = thermostatIds(this.gladys, thermostat.id);
      const device = created.get(ids.device);
      if (device) push(ids, device, thermostatStates(thermostat), thermostat.unit);
      for (const zone of thermostat.zones) {
        const zids = zoneIds(this.gladys, zone.id);
        const zoneDevice = created.get(zids.device);
        if (zoneDevice) push(zids, zoneDevice, zoneStates(thermostat, zone), thermostat.unit);
      }
    }
    return out;
  }

  /** Publish what changed, within the per-minute budget. Never throws. */
  async publishStates() {
    let list = this.states();
    if (list.length === 0) return;
    const remaining = this.budget.remaining();
    if (list.length > remaining) {
      // In turn: the next cut starts where this one stopped, so no feature
      // is held back for ever (the SDK skips the unchanged ones anyway).
      this.logger.debug(`${list.length - remaining} state(s) held back (state budget)`);
      const start = this.budgetCursor % list.length;
      list = [...list.slice(start), ...list.slice(0, start)].slice(0, remaining);
      this.budgetCursor = start + remaining;
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list, {
        heartbeat: INTERVALS.HEARTBEAT_MS,
      });
      this.budget.record(result?.count ?? list.length);
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  transportOf(thermostat) {
    if (!this.online || !thermostat) return { transport: 'unreachable' };
    if (!thermostat.connected) {
      return { transport: 'unreachable', degraded: true, message: T.badge.offline };
    }
    return { transport: 'cloud' };
  }

  async publishTransports() {
    const created = createdDevices(this.gladys);
    const entries = [];
    const byDevice = new Map();
    for (const thermostat of this.thermostats) {
      byDevice.set(thermostatIds(this.gladys, thermostat.id).device, thermostat);
      for (const zone of thermostat.zones) {
        byDevice.set(zoneIds(this.gladys, zone.id).device, thermostat);
      }
    }
    for (const externalId of created.keys()) {
      if (!parseExternalId(this.gladys, externalId)) continue;
      entries.push({ external_id: externalId, ...this.transportOf(byDevice.get(externalId)) });
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== JSON.stringify(e));
    for (let start = 0; start < changed.length; start += LIMITS.TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + LIMITS.TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, JSON.stringify(entry));
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Commands --------------------------------------------------------------
  //
  // Heating and cooling setpoints, zone mode (off, heating, cooling, auto),
  // fan mode. Refused unless the user allowed them (`allow_control`, off by
  // default), checked when the command arrives AND just before it is sent.
  // A setpoint is checked on its raw value, in the unit of the feature,
  // against plausible bounds BEFORE any conversion or rounding (refused,
  // never clamped), then converted to the thermostat's unit, rounded like
  // the library (1 °F, 0.5 °C) and checked against the thermostat's own
  // limits and deadband (the other setpoint moves to keep the deadband, as
  // the library does, and must stay within its own limits).
  // The commands run one after the other (one account), use the client of
  // the moment they arrived (a new configuration in between refuses them),
  // and read the house from the cloud just before acting: unknown thermostat
  // or zone, offline thermostat, or a reading that fails, and nothing is
  // sent; the value already there, and nothing is sent either. Gladys waits
  // 5 s: past 3.5 s after the command arrived, nothing is sent any more; once
  // sent, Gladys gets its answer at most 4.3 s after the command.

  async setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    const kind = this.commandKind(parsed);
    if (!kind) {
      throw new Error(parsed?.feature ? T.errors.readOnly : T.errors.unknownFeature);
    }
    const request = { kind, parsed };
    if (kind === 'setpoint') {
      // The unit of the feature as created in Gladys: the value is in it.
      const created = createdDevices(this.gladys)
        .get(zoneIds(this.gladys, parsed.id).device)
        ?.features?.find((f) => f.external_id === feature.external_id);
      const unit = created?.unit ?? feature?.unit;
      const bounds = SETPOINT_BOUNDS[unit];
      if (!bounds) throw new Error(T.errors.unknownUnit);
      // The raw value is checked BEFORE converting or rounding.
      const raw = Number(value);
      if (
        typeof value === 'boolean' ||
        value === null ||
        value === '' ||
        !Number.isFinite(raw) ||
        raw < bounds.min ||
        raw > bounds.max
      ) {
        throw new Error(T.errors.invalidSetpoint(bounds.min, bounds.max, unitSymbol(unit)));
      }
      request.value = raw;
      request.unit = nexiaUnit(unit);
    } else if (kind === 'mode') {
      const n = Number(value);
      if (typeof value === 'boolean' || !Number.isInteger(n) || !(n in MODE_OF_VALUE)) {
        throw new Error(T.errors.invalidMode);
      }
      request.value = n;
    } else {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(value)) {
        throw new Error(T.errors.invalidFanMode);
      }
      request.value = value;
    }
    if (!this.config.allowControl) throw new Error(T.errors.controlDisabled);
    if (this.paused()) throw new Error(T.errors.busy);
    const client = this.client;
    if (!client || this.blocked || !this.online) throw new Error(T.errors.notConnected);
    // A request still in flight after its answer to Gladys (a slow cloud, up
    // to 20 s): refused at once, never queued behind it (Gladys gives up at
    // 5 s, and the command must never run after that).
    if (this.inFlight) throw new Error(T.errors.inFlight);
    const generation = this.generation;
    // job.tail: this command's request, when still in flight once Gladys was answered.
    const job = { tail: null };
    const run = this.commands.then(() =>
      this.command(received, { client, generation, job, ...request }),
    );
    this.commands = run.catch(() => {});
    return run;
  }

  commandKind(parsed) {
    if (parsed?.kind === 'zone') {
      if (parsed.feature === ZF.HEAT_SETPOINT || parsed.feature === ZF.COOL_SETPOINT) {
        return 'setpoint';
      }
      if (parsed.feature === ZF.MODE) return 'mode';
    }
    if (parsed?.kind === 'thermostat' && parsed.feature === TF.FAN_MODE) return 'fan';
    return null;
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new CommandError(T.errors.configChanged);
    }
    if (!this.config.allowControl) throw new CommandError(T.errors.controlDisabled);
    if (this.paused()) throw new CommandError(T.errors.busy);
  }

  /** A failure of the cloud met by a command: a 429 or a refusal applies to every path. */
  async shared(err, generation) {
    if (generation !== this.generation) return;
    // failed() pauses every path on a 429 and stops on a refusal.
    if (isRateLimited(err) || isRefused(err)) await this.failed(err, generation);
  }

  async command(received, request) {
    const { client, generation, parsed, job } = request;
    this.activeCommands += 1;
    this.stateVersion += 1;
    const end = () => {
      this.stateVersion += 1;
      this.activeCommands -= 1;
    };
    try {
      this.stillValid(request);
      // Queued behind a command whose request outlived its answer: refused, never run later.
      if (this.inFlight) throw new CommandError(T.errors.inFlight);
      const deadline = received + COMMAND_BUDGET_MS;
      if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new CommandError(T.errors.tooSlow);
      let json;
      try {
        ({ json } = await client.house({ deadline: deadline - COMMAND_MIN_SEND_MS }));
      } catch (err) {
        await this.shared(err, generation);
        throw new CommandError(T.errors.unknownState(err), { cause: err });
      }
      if (client === this.client && generation === this.generation) this.apply(json);
      const { thermostat, zone } = this.locate(parsed);
      if (!thermostat || (parsed.kind === 'zone' && !zone)) {
        void this.publishStates();
        throw new CommandError(T.errors.gone);
      }
      if (!thermostat.connected) throw new CommandError(T.errors.offline);
      const plan = this.plan(request, thermostat, zone);
      if (!plan) {
        // Already so: nothing to send.
        void this.publishStates();
        return;
      }
      if (deadline - this.now() < COMMAND_MIN_SEND_MS) throw new CommandError(T.errors.tooSlow);
      // The last check before acting: the user may have changed things meanwhile.
      this.stillValid(request);
      await this.send({ ...request, plan, thermostat, zone, received });
    } finally {
      // A request still in flight keeps the readings from overwriting its result.
      if (job.tail) job.tail.then(end);
      else end();
    }
  }

  locate(parsed) {
    if (parsed.kind === 'thermostat') {
      return { thermostat: this.thermostats.find((t) => t.id === parsed.id) ?? null, zone: null };
    }
    for (const thermostat of this.thermostats) {
      const zone = thermostat.zones.find((z) => z.id === parsed.id);
      if (zone) return { thermostat, zone };
    }
    return { thermostat: null, zone: null };
  }

  /** What to send: { action, fallback, payload }, or null when already so. */
  plan(request, thermostat, zone) {
    if (request.kind === 'setpoint') return this.planSetpoint(request, thermostat, zone);
    if (request.kind === 'mode') {
      const wanted = MODE_OF_VALUE[request.value];
      const option = zone.modeOptions.find((o) => o.mode === wanted);
      if (zone.modeOptions.length > 0 && !option) throw new CommandError(T.errors.invalidMode);
      if (zone.mode === wanted) return null;
      return {
        action: zone.actions.mode,
        fallback: this.zoneFallback(zone, 'zone_mode'),
        // Upper case, as the library sends it to every model (UX360 included).
        payload: { value: wanted },
      };
    }
    const option = fanOptions(thermostat).find((o) => o.value === request.value);
    if (!option) throw new CommandError(T.errors.invalidFanMode);
    if (thermostat.fan.value === option.value) return null;
    return {
      action: thermostat.fan.action,
      // The xxl_thermostats fallback is the XL series' path only.
      fallback:
        thermostat.type === null || thermostat.type.startsWith('xxl')
          ? `xxl_thermostats/${thermostat.rawId}/fan_mode`
          : null,
      payload: { value: option.value },
    };
  }

  /**
   * The library's fallback path of a zone setting, or null (refused) for a
   * zone the thermostat numbers 1, 2... (UX360): xxl_zones/<n> would be
   * another zone, or nothing.
   */
  zoneFallback(zone, setting) {
    return zone.numbered ? null : `xxl_zones/${zone.rawId}/${setting}`;
  }

  planSetpoint(request, thermostat, zone) {
    const unit = thermostat.unit;
    const symbol = unitSymbol(unit);
    const heatKey = request.parsed.feature === ZF.HEAT_SETPOINT;
    // In the thermostat's unit, converted exactly then rounded once to its
    // step, like the library (zone.py round_temp: 1 °F, 0.5 °C).
    const converted = convertExact(request.value, request.unit, unit);
    const step = SETPOINT_STEP[unit];
    const value = Math.round(converted / step) * step;
    const { heatMin, heatMax, coolMin, coolMax } = zone.limits;
    // No deadband given: none is assumed, the command is refused.
    if ([heatMin, heatMax, coolMin, coolMax, zone.deadband].some((n) => n === null)) {
      throw new CommandError(T.errors.unknownLimits);
    }
    const [min, max] = heatKey ? [heatMin, heatMax] : [coolMin, coolMax];
    if (value < min - EPSILON || value > max + EPSILON) {
      throw new CommandError(
        T.errors.outOfLimits(heatKey ? 'heating' : 'cooling', min, max, symbol),
      );
    }
    const deadband = zone.deadband;
    // zone.py set_heat_cool_temp: the other setpoint moves to keep the deadband.
    const currentHeat = zone.heat ?? heatMin;
    const currentCool = zone.cool ?? coolMax;
    const heat = heatKey ? value : Math.min(currentHeat, value - deadband);
    const cool = heatKey ? Math.max(currentCool, value + deadband) : value;
    if (
      heat < heatMin - EPSILON ||
      heat > heatMax + EPSILON ||
      cool < coolMin - EPSILON ||
      cool > coolMax + EPSILON ||
      cool - heat < deadband - EPSILON
    ) {
      throw new CommandError(T.errors.deadband(deadband, symbol));
    }
    if (zone.heat === heat && zone.cool === cool) return null;
    return {
      action: zone.actions.setpoints,
      fallback: this.zoneFallback(zone, 'setpoints'),
      payload: { heat, cool },
    };
  }

  /**
   * Send, then answer Gladys on the cloud's answer or at COMMAND_ACK_MS,
   * whichever first. Once the last check passed, the request runs with the
   * full request timeout (never cut at the command budget: a slow cloud may
   * still apply it); past the answer it is "sent, not confirmed", and the
   * next command waits for its real end.
   */
  async send({ client, generation, kind, plan, thermostat, zone, received, job }) {
    let target;
    try {
      target = client.resolve(plan.action, plan.fallback);
    } catch (err) {
      throw new CommandError(T.errors.notSent(err), { cause: err });
    }
    const request = client.send({
      url: target.url,
      method: target.method,
      payload: plan.payload,
    });
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, Math.max(0, received + COMMAND_ACK_MS - this.now()));
    });
    const outcome = await Promise.race([
      request.then(
        (result) => ({ done: true, result }),
        (err) => ({ err }),
      ),
      ack.then(() => ({ pending: true })),
    ]);
    this.timers.clearTimeout(handle);
    const label = `${kind} of ${zone ? `zone ${zone.id}` : `thermostat ${thermostat.id}`}`;
    const after = (result) => {
      if (generation !== this.generation || client !== this.client) return;
      this.observed(kind === 'fan' ? 'thermostat' : 'zone', thermostat, zone, result);
      void this.publishStates();
      this.readSoon(generation);
    };
    if (outcome.done) {
      this.logger.info(`${label} sent`);
      after(outcome.result);
      return;
    }
    if (outcome.pending) {
      // Sent, the cloud still at work: Gladys is answered now, the state follows.
      this.logger.info(`${label} sent, the cloud has not answered yet`);
      job.tail = request
        .then(after, async (err) => {
          // Not confirmed (it may still have been applied): read again soon.
          this.logger.warn(`${label} not confirmed: ${err?.code ?? 'error'}`);
          // A late 429 / refusal still applies to every path.
          await this.shared(err, generation);
          if (generation === this.generation && client === this.client) this.readSoon(generation);
        })
        .catch((err) => this.logger.error(`Command follow-up failed: ${err?.message ?? 'error'}`))
        .finally(() => {
          if (this.inFlight === job.tail) this.inFlight = null;
        });
      this.inFlight = job.tail;
      return;
    }
    const { err } = outcome;
    await this.shared(err, generation);
    if (err?.code === CODES.NETWORK) {
      // The connection may have dropped after the request left: it may or may
      // not have reached the cloud. Read again soon to show what is true.
      if (generation === this.generation && client === this.client) this.readSoon(generation);
      throw new CommandError(T.errors.maybeNotSent, { cause: err });
    }
    if (err?.notSent) throw new CommandError(T.errors.notSent(err), { cause: err });
    throw new CommandError(T.errors.refused(err), { cause: err });
  }

  /**
   * What the cloud answered to a command (the zone or the thermostat, when
   * the answer carries it), merged into the last house read until the next
   * reading; the next reading asks for the whole house again (no 304).
   */
  observed(kind, thermostat, zone, result) {
    const cache = this.client?.cache;
    if (!cache) return;
    this.client.etag = undefined;
    if (!isObject(result) || Object.keys(result).length < 3) return;
    const item = deviceItemsOf(cache).find((i) => String(i.id) === thermostat.id);
    if (!item) return;
    // Only an answer that is the very zone or thermostat commanded is merged.
    const expected = kind === 'thermostat' ? thermostat.rawId : zone.rawId;
    if (String(result.id) !== String(expected)) return;
    if (kind === 'thermostat') {
      const zones = Array.isArray(result.zones) ? result.zones : null;
      Object.assign(item, result, { zones: item.zones });
      for (const update of zones ?? []) {
        const known = (item.zones ?? []).find((z) => z?.id === update?.id);
        if (known && isObject(update)) Object.assign(known, update);
      }
    } else {
      const known = (item.zones ?? []).find((z) => z?.id === zone.rawId);
      if (known) Object.assign(known, result);
    }
    this.apply(cache);
  }

  /** A reading soon after a command (the cloud shows a change after a few seconds). */
  readSoon(generation) {
    if (!this.client || this.blocked || generation !== this.generation) return;
    const at = this.now() + INTERVALS.AFTER_COMMAND_MS;
    if (at < this.nextReadAt && !this.paused()) {
      this.nextReadAt = at;
      this.scheduleRead(INTERVALS.AFTER_COMMAND_MS, generation);
    }
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  async deviceCreated(device) {
    if (!parseExternalId(this.gladys, device?.external_id) || !this.online) return;
    await this.publishStates();
    await this.publishTransports();
  }

  async deviceUpdated(device) {
    this.transports.delete(device?.external_id);
    await this.deviceCreated(device);
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration button --------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /**
   * With a working session: reads the house again, no new sign-in. Else signs
   * in again (a refusal included: the user asked, at most once a minute after
   * a refusal). Reports within 25 s.
   */
  async testConnection() {
    const reread = this.client?.hasSession && !this.blocked && this.online && !this.paused();
    const task = reread
      ? this.enqueue(async () => {
          const generation = this.generation;
          await this.refresh({ publish: true }).catch((err) => this.failed(err, generation));
        })
      : this.start(this.rawConfig, { force: true });
    await this.within(task, TEST_BUDGET_MS, T.errors.testTooLong);
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({
      house: this.client?.houseName ?? null,
      thermostats: this.thermostats.length,
      zones: this.thermostats.reduce((n, t) => n + t.zones.length, 0),
    });
  }
}
