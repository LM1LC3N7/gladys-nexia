// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake cloud, through
// the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES as C } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NexiaApp } from '../src/app.js';
import { accountKey, normalizeConfig } from '../src/config.js';
import {
  ACTIONS,
  COMMAND_ACK_MS,
  INTERVALS,
  REFUSED_RETRIES_MS,
  TIMEOUTS,
} from '../src/constants.js';
import { buildThermostatDevice, buildZoneDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { thermostatsOf } from '../src/nexia/model.js';
import { memoryStore } from '../src/store.js';
import { EMAIL, PASSWORD, createFakeCloud, fixture } from './helpers/fakeCloud.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-17T08:00:00Z');
const SELECTOR = 'nexia';
const ids = createFakeGladys({ selector: SELECTOR });
const BASE_CONFIG = { brand: 'nexia', email: EMAIL, password: PASSWORD };
const ALLOW = { allow_control: true };

/** The devices the user would create from a fixture: every thermostat and zone. */
function devicesOf(house) {
  const devices = [];
  for (const t of thermostatsOf(fixture(house)).thermostats) {
    devices.push(buildThermostatDevice(ids, t, 'fr'));
    for (const z of t.zones) devices.push(buildZoneDevice(ids, t, z, 'fr'));
  }
  return devices;
}

const XL = 'single_zone_xl1050';
const THERMOSTAT = `ext:${SELECTOR}:thermostat:345678`;
const ZONE = `ext:${SELECTOR}:zone:234567`;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({
  config = {},
  house = XL,
  created,
  cloud,
  store = memoryStore(),
  clock = { now: T0 },
} = {}) {
  cloud ??= createFakeCloud({ house });
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: created ?? devicesOf(house),
  });
  const timers = createFakeTimers();
  cloud.timers = timers;
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new NexiaApp({
    gladys,
    logger,
    request: cloud.request,
    now: () => clock.now,
    timers,
    store,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, cloud, timers, clock, logs, app, store };
}

const feature = (gladys, deviceId, key) =>
  gladys.fake.devices
    .find((d) => d.external_id === deviceId)
    .features.find((f) => f.external_id === `${deviceId}:${key}`);
const device = (gladys, deviceId) => gladys.fake.devices.find((d) => d.external_id === deviceId);
const state = (gladys, deviceId, key) => gladys.fake.lastState(`${deviceId}:${key}`);
const badge = (gladys, deviceId) =>
  gladys.fake.transports.filter((t) => t.device_external_id === deviceId).at(-1);
const poll = (timers) => timers.run((ms) => ms === INTERVALS.POLL_MS);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await tick();
};
const set = (gladys, deviceId, key, value) =>
  gladys.fake.setValue(device(gladys, deviceId), feature(gladys, deviceId, key), value);

// --- Reading ---------------------------------------------------------------------

test('start: one login, Discovery, the states, the status and the badges', async () => {
  const { gladys, cloud, timers, store } = await setup();
  assert.equal(cloud.logins, 1);
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: { en: 'Connected: 1 thermostat, 1 zone.', fr: 'Connecté : 1 thermostat, 1 zone.' },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [THERMOSTAT, 'Thermostat 1 (système)'],
      [ZONE, 'Thermostat 1'],
    ],
  );
  assert.equal(state(gladys, ZONE, 'temperature'), 74);
  assert.equal(state(gladys, ZONE, 'heat-setpoint'), 68);
  assert.equal(state(gladys, ZONE, 'cool-setpoint'), 73);
  assert.equal(state(gladys, ZONE, 'mode'), 3, 'AUTO');
  assert.equal(state(gladys, ZONE, 'operating-state'), 2, 'cooling');
  assert.equal(state(gladys, ZONE, 'setpoint-status'), 'Permanent Hold');
  assert.equal(state(gladys, THERMOSTAT, 'humidity'), 59);
  assert.equal(state(gladys, THERMOSTAT, 'outdoor-temperature'), 64);
  assert.equal(state(gladys, THERMOSTAT, 'system-status'), 'Cooling');
  assert.equal(state(gladys, THERMOSTAT, 'fan-mode'), 'circulate');
  assert.equal(state(gladys, THERMOSTAT, 'dehumidify-setpoint'), 50);
  assert.equal(badge(gladys, THERMOSTAT).transport, 'cloud');
  assert.equal(badge(gladys, ZONE).transport, 'cloud');
  assert.deepEqual(timers.delays(), [INTERVALS.POLL_MS]);
  // The session headers; the device uuid is stable and kept in /data.
  const read = cloud.requests.find((r) => r.method === 'GET');
  assert.equal(read.headers['X-ApiKey'], 'key-1');
  assert.equal(read.headers['X-MobileId'], '5401');
  assert.equal(read.headers['X-AssociatedBrand'], 'nexia');
  assert.equal(read.headers['X-AppVersion'], '6.0.0');
  const signIn = cloud.requests.find((r) => r.path === '/mobile/accounts/sign_in');
  assert.equal(signIn.body.device_uuid, store.data.deviceUuid);
  assert.equal(signIn.body.device_name, 'Gladys Assistant');
  assert.doesNotMatch(JSON.stringify(store.data), new RegExp(PASSWORD));
  assert.doesNotMatch(JSON.stringify(store.data), /example\.com/);
});

test('each reading keeps the session (no new login) and asks with If-None-Match', async () => {
  const { gladys, cloud, timers } = await setup();
  await poll(timers);
  await poll(timers);
  assert.equal(cloud.logins, 1);
  const reads = cloud.requests.filter((r) => r.method === 'GET');
  assert.equal(reads.length, 3);
  assert.equal(reads[1].headers['If-None-Match'], '"v1"', '304: nothing new');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  cloud.thermostat('345678').zones[0].temperature = 75;
  cloud.touch();
  await poll(timers);
  assert.equal(state(gladys, ZONE, 'temperature'), 75);
  assert.deepEqual(timers.delays(), [INTERVALS.POLL_MS]);
});

test('an expired session: one new login, then the reading goes on', async () => {
  const { gladys, cloud, timers, clock } = await setup();
  clock.now += 30 * 60_000;
  cloud.apiKey = 'rotated';
  await poll(timers);
  assert.equal(cloud.logins, 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a session refused right after its login: no login loop, the spacing doubles', async () => {
  const { gladys, cloud, timers, clock } = await setup();
  clock.now += 30 * 60_000;
  cloud.apiKey = 'rotated';
  cloud.failures.push(
    { match: (r) => r.method === 'GET', status: 302 },
    { match: (r) => r.method === 'GET', status: 302 },
  );
  await poll(timers);
  assert.equal(cloud.logins, 2, 'one new login only');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the session just after/);
  assert.deepEqual(timers.delays(), [10 * 60_000], 'the next login 10 min after the last one');
  clock.now += 10 * 60_000;
  await timers.run();
  assert.equal(cloud.logins, 3, 'a new login at its time');
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('°C thermostats: the values in °C, and converted when the feature was created in °F', async () => {
  const created = devicesOf('issue_79891');
  const zone = created.find((d) => d.external_id === `ext:${SELECTOR}:zone:83496154`);
  for (const f of zone.features) {
    if (f.unit === 'celsius') f.unit = 'fahrenheit';
  }
  const { gladys } = await setup({ house: 'issue_79891', created });
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:83261001`, 'temperature'), 26);
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:83261001`, 'heat-setpoint'), 20);
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:83496154`, 'temperature'), 78.8, '26 °C');
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:83496154`, 'cool-setpoint'), 79.7, '26.5 °C');
  // The republished device keeps the unit it was created with.
  const republished = gladys.fake.discoveredDevices.find((d) => d.external_id === zone.external_id);
  assert.equal(
    republished.features.find((f) => f.external_id.endsWith(':temperature')).unit,
    'fahrenheit',
  );
});

test('a republished device never loses a feature it was created with', async () => {
  const created = devicesOf(XL);
  const thermostat = created.find((d) => d.external_id === THERMOSTAT);
  thermostat.features.push({
    name: 'Humidify',
    external_id: `${THERMOSTAT}:humidify-setpoint`,
    category: C.UNKNOWN,
    type: 'unknown',
    read_only: true,
    has_feedback: false,
    keep_history: true,
    min: 0,
    max: 100,
  });
  const { gladys } = await setup({ created });
  const republished = gladys.fake.discoveredDevices.find((d) => d.external_id === THERMOSTAT);
  assert.ok(republished.features.some((f) => f.external_id.endsWith(':humidify-setpoint')));
});

test('groups, UX360 zone ids, thermostats without zone', async () => {
  const grouped = await setup({ house: 'grouped_xl850' });
  assert.ok(
    grouped.gladys.fake.discoveredDevices.some(
      (d) => d.external_id === `ext:${SELECTOR}:thermostat:2323232`,
    ),
  );
  await running.stop();
  const ux = await setup({ house: 'two_ux360_multizone' });
  assert.deepEqual(
    ux.gladys.fake.discoveredDevices
      .filter((d) => d.external_id.includes(':zone:'))
      .map((d) => d.external_id.split(':zone:')[1]),
    ['0000000001_1', '0000000001_2', '0000000001_3', '0000000002_1', '0000000002_2'],
  );
  await running.stop();
  const xl624 = await setup({ house: 'mobile_house_xl624' });
  assert.equal(
    xl624.gladys.fake.discoveredDevices.filter((d) => d.external_id.includes(':thermostat:'))
      .length,
    2,
  );
  assert.ok(xl624.logs.some((l) => /"Downstairs Hall" left out: no zone/.test(l)));
});

test('a thermostat offline for the cloud: unreachable badge, no stale states', async () => {
  const { gladys } = await setup({ house: 'system_offline' });
  const offline = `ext:${SELECTOR}:thermostat:2224092`;
  assert.equal(badge(gladys, offline).transport, 'unreachable');
  assert.equal(badge(gladys, offline).degraded, true);
  assert.equal(badge(gladys, `ext:${SELECTOR}:zone:83354736`).transport, 'unreachable');
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:83354736`, 'temperature'), undefined);
  assert.equal(state(gladys, `ext:${SELECTOR}:zone:84274348`, 'temperature'), 78);
  assert.match(gladys.fake.connectionStatus.message.en, /2 thermostats are offline/);
});

test('cloud unreachable: retried at 120 s then slower, up to 30 min, never faster', async () => {
  const { gladys, cloud, timers } = await setup();
  cloud.unreachable = true;
  await poll(timers);
  assert.equal(badge(gladys, ZONE).transport, 'unreachable');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer: no connection/);
  assert.deepEqual(timers.delays(), [120_000]);
  await timers.run();
  assert.deepEqual(timers.delays(), [240_000]);
  for (let i = 0; i < 8; i += 1) await timers.run();
  assert.deepEqual(timers.delays(), [INTERVALS.RETRY_MAX_MS]);
  cloud.unreachable = false;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(timers.delays(), [INTERVALS.POLL_MS]);
});

test('remote texts and secrets never reach the logs', async () => {
  const { cloud, timers, logs } = await setup();
  cloud.failures.push({
    match: (r) => r.method === 'GET',
    status: 502,
    body: { error: 'remote text' },
  });
  await poll(timers);
  const all = logs.join('\n');
  assert.ok(all.includes('HTTP') || all.includes('502'));
  assert.ok(!all.includes('remote text'));
  assert.ok(!all.includes(PASSWORD));
  assert.ok(!all.includes('key-1'));
  assert.ok(!all.includes(EMAIL));
});

// --- Refusal, pause, reconnection ------------------------------------------------

test('password refused: stops, two automatic tries (6 h, 24 h) kept in /data, then none', async () => {
  const store = memoryStore();
  const clock = { now: T0 };
  const { gladys, cloud, timers } = await setup({
    config: { password: 'wrong' },
    store,
    clock,
  });
  assert.equal(cloud.logins, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /refused the e-mail address or the password/,
  );
  assert.match(gladys.fake.connectionStatus.message.en, /in 6 h \(2 automatic tries left\)/);
  assert.deepEqual(timers.delays(), [REFUSED_RETRIES_MS[0]]);
  assert.equal(store.data.refusal.tries, 1);
  assert.equal(store.data.refusal.account, accountKey(normalizeConfig(BASE_CONFIG)));
  // A reconnection to Gladys does not try again, and says it again.
  const statuses = gladys.fake.connectionStatuses.length;
  await gladys.disconnect();
  await gladys.connect();
  assert.equal(cloud.logins, 1);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'status published again');
  clock.now += REFUSED_RETRIES_MS[0];
  await timers.run();
  await settle();
  assert.equal(cloud.logins, 2);
  assert.equal(store.data.refusal.tries, 2);
  assert.match(gladys.fake.connectionStatus.message.en, /in 24 h \(1 automatic try left\)/);
  assert.deepEqual(timers.delays(), [REFUSED_RETRIES_MS[1]]);
  clock.now += REFUSED_RETRIES_MS[1];
  await timers.run();
  await settle();
  assert.equal(cloud.logins, 3);
  assert.equal(store.data.refusal.nextAt, null);
  assert.deepEqual(timers.delays(), [], 'no more automatic try');
  assert.match(gladys.fake.connectionStatus.message.en, /does not try again by itself/);
  // A restart of the container with the same account: still stopped.
  await running.stop();
  const again = await setup({ config: { password: 'wrong' }, store, clock, cloud });
  assert.equal(cloud.logins, 3);
  assert.equal(again.gladys.fake.connectionStatus.connected, false);
  // The button right after a refusal: the sign-in waits a minute.
  let ack = await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.match(ack.error, /moments ago/);
  assert.equal(cloud.logins, 3);
  // A minute later the button tries again (the user asked) — and fails again.
  clock.now += 60_000;
  ack = await again.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, false);
  assert.equal(cloud.logins, 4);
  clock.now += 60_000;
  // The right password saved: connected, the refusal forgotten.
  await again.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refusal, null);
});

test('HTTP 429: every path pauses, the pause survives a restart, bounded to 6 h', async () => {
  const store = memoryStore();
  const clock = { now: T0 };
  const { gladys, cloud, timers } = await setup({ store, clock, config: ALLOW });
  cloud.failures.push({ match: (r) => r.method === 'GET', status: 429, retryAfterMs: 120_000 });
  await poll(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [120_000]);
  assert.equal(store.data.pausedUntil, T0 + 120_000);
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.match(ack.error, /slow down/);
  assert.equal(cloud.commands().length, 0);
  // A restart 30 s later: nothing is sent before the end of the pause.
  await running.stop();
  clock.now += 30_000;
  const sent = cloud.requests.length;
  const again = await setup({ store, clock, cloud, config: ALLOW });
  assert.equal(cloud.requests.length, sent);
  assert.deepEqual(again.timers.delays(), [90_000]);
  clock.now += 90_000;
  await again.timers.run();
  assert.equal(again.gladys.fake.connectionStatus.connected, true);
  // A huge Retry-After is bounded.
  cloud.failures.push({
    match: (r) => r.method === 'GET',
    status: 429,
    retryAfterMs: 48 * 3600_000,
  });
  await poll(again.timers);
  assert.deepEqual(again.timers.delays(), [INTERVALS.BUSY_MAX_MS]);
});

test('a reconnection to Gladys publishes the status, Discovery and the states again', async () => {
  const { gladys, cloud, timers } = await setup();
  const sent = cloud.requests.length;
  const discoveries = gladys.fake.requests.filter((r) => r.path === '/discovered_device').length;
  const statuses = gladys.fake.connectionStatuses.length;
  const states = gladys.fake.states.length;
  await gladys.disconnect();
  assert.deepEqual(timers.delays(), [], 'the loop pauses while Gladys is away');
  await gladys.connect();
  assert.equal(cloud.requests.length, sent, 'no reading before the interval');
  assert.ok(
    gladys.fake.requests.filter((r) => r.path === '/discovered_device').length > discoveries,
  );
  assert.ok(gladys.fake.connectionStatuses.length > statuses);
  assert.ok(gladys.fake.states.length > states);
  assert.deepEqual(timers.delays(), [INTERVALS.POLL_MS]);
});

test('configuration: missing fields and an odd e-mail are said, nothing is sent', async () => {
  const empty = await setup({ config: { email: '', password: '' } });
  assert.match(empty.gladys.fake.connectionStatus.message.en, /type the e-mail address/);
  assert.equal(empty.cloud.requests.length, 0);
  await running.stop();
  const odd = await setup({ config: { email: 'not-an-address' } });
  assert.match(odd.gladys.fake.connectionStatus.message.en, /does not look valid/);
  assert.equal(odd.cloud.requests.length, 0);
});

test('brands: the cloud of the brand chosen', async () => {
  const cloud = createFakeCloud({ root: 'https://asairhome.com' });
  const { gladys } = await setup({ cloud, config: { brand: 'asair' } });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.ok(cloud.requests.every((r) => r.headers['X-AssociatedBrand'] === 'asair'));
});

test('the test button: a working session reads the house again, no new sign-in', async () => {
  const { gladys, cloud } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.message, {
    en: 'Connected to "My Home": 1 thermostat, 1 zone.',
    fr: 'Connecté à « My Home » : 1 thermostat, 1 zone.',
  });
  assert.equal(cloud.logins, 1);
  assert.equal(cloud.requests.at(-1).method, 'GET');
});

// --- Commands ----------------------------------------------------------------------

test('safety of the features: no switch, the commands are setpoints, modes and fan only', () => {
  const features = devicesOf(XL).flatMap((d) => d.features);
  assert.ok(features.every((f) => f.category !== C.SWITCH));
  assert.ok(features.every((f) => !(f.type === 'binary' && !f.read_only)));
  assert.deepEqual(
    features.filter((f) => !f.read_only).map((f) => f.external_id.split(':').at(-1)),
    ['fan-mode', 'heat-setpoint', 'cool-setpoint', 'mode'],
  );
});

test('commands are off by default: refused, nothing sent', async () => {
  const { gladys, cloud } = await setup();
  for (const [id, key, value] of [
    [ZONE, 'heat-setpoint', 70],
    [ZONE, 'mode', 0],
    [THERMOSTAT, 'fan-mode', 'on'],
  ]) {
    const ack = await set(gladys, id, key, value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Commands are off/);
  }
  assert.equal(cloud.commands().length, 0);
});

test('heating setpoint: fresh read first, the deadband kept, the state published', async () => {
  const { gladys, cloud, timers } = await setup({ config: ALLOW });
  const before = cloud.requests.length;
  let ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, true, ack.error);
  const after = cloud.requests.slice(before);
  assert.deepEqual(
    after.map((r) => `${r.method} ${r.path}`),
    ['GET /mobile/houses/123456', 'POST /mobile/xxl_zones/234567/setpoints'],
  );
  assert.deepEqual(after[1].body, { heat: 70, cool: 73 });
  await settle();
  assert.equal(state(gladys, ZONE, 'heat-setpoint'), 70);
  assert.ok(timers.delays().includes(INTERVALS.AFTER_COMMAND_MS), 'a reading soon after');
  // 72 °F with a 3 °F deadband: the cooling setpoint moves to 75.
  ack = await set(gladys, ZONE, 'heat-setpoint', 72);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(cloud.commands().at(-1).body, { heat: 72, cool: 75 });
  // The same value again: nothing sent.
  const count = cloud.commands().length;
  ack = await set(gladys, ZONE, 'heat-setpoint', 72);
  assert.equal(ack.success, true);
  assert.equal(cloud.commands().length, count);
});

test('a short command answer: the reading 10 s later shows the change', async () => {
  const { gladys, cloud, timers } = await setup({ config: ALLOW });
  cloud.commandAnswer = 'short';
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, true, ack.error);
  await settle();
  assert.equal(state(gladys, ZONE, 'heat-setpoint'), 68, 'nothing invented');
  await timers.run((ms) => ms === INTERVALS.AFTER_COMMAND_MS);
  assert.equal(state(gladys, ZONE, 'heat-setpoint'), 70);
  const last = cloud.requests.at(-1);
  assert.equal(last.method, 'GET');
  assert.equal(last.headers['If-None-Match'], undefined, 'the whole house asked again');
});

test('setpoints: checked raw before rounding, then against the thermostat limits', async () => {
  const { gladys, cloud } = await setup({ config: ALLOW });
  for (const value of [99.4, 39.6, 22 - 100, 'abc', true, null, '']) {
    const ack = await set(gladys, ZONE, 'cool-setpoint', value);
    assert.equal(ack.success, false, String(value));
    assert.match(ack.error, /Invalid setpoint: a temperature from 40 to 99 °F/);
  }
  let ack = await set(gladys, ZONE, 'heat-setpoint', 95);
  assert.equal(ack.success, false);
  assert.match(ack.error, /heating setpoint must stay from 55 to 90 °F/);
  ack = await set(gladys, ZONE, 'cool-setpoint', 50);
  assert.equal(ack.success, false);
  assert.match(ack.error, /cooling setpoint must stay from 60 to 99 °F/);
  // 89 °F heating would push cooling to 92: allowed; 90 heating -> 93 cooling, allowed too.
  ack = await set(gladys, ZONE, 'heat-setpoint', 89.6);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(cloud.commands().at(-1).body, { heat: 90, cool: 93 });
  ack = await set(gladys, ZONE, 'cool-setpoint', 60);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(cloud.commands().at(-1).body, { heat: 57, cool: 60 });
  assert.equal(cloud.commands().length, 2);
});

test('°C: rounded to 0.5 °C, sent where the UX360 says (PUT); a °F feature converted', async () => {
  const created = devicesOf('issue_79891');
  const native = created.find((d) => d.external_id === `ext:${SELECTOR}:zone:83496154`);
  for (const f of native.features) if (f.unit === 'celsius') f.unit = 'fahrenheit';
  const { gladys, cloud } = await setup({ house: 'issue_79891', created, config: ALLOW });
  const ux = `ext:${SELECTOR}:zone:83261001`;
  let ack = await set(gladys, ux, 'heat-setpoint', 21.3);
  assert.equal(ack.success, true, ack.error);
  let sent = cloud.commands().at(-1);
  assert.equal(sent.method, 'PUT');
  assert.equal(sent.path, '/mobile/diagnostics/thermostats/2222249/setpoints/83261001');
  assert.deepEqual(sent.body, { heat: 21.5, cool: 27 });
  // 22 (as °C) to a feature created in °F: refused raw, never taken as 22 °F.
  ack = await set(gladys, native.external_id, 'heat-setpoint', 22);
  assert.equal(ack.success, false);
  assert.match(ack.error, /from 40 to 99 °F/);
  ack = await set(gladys, native.external_id, 'heat-setpoint', 75);
  assert.equal(ack.success, true, ack.error);
  sent = cloud.commands().at(-1);
  assert.equal(sent.path, '/mobile/xxl_zones/83496154/setpoints');
  assert.deepEqual(sent.body, { heat: 24, cool: 26.5 }, '75 °F = 23.9 °C, rounded to 24');
});

test('zone mode: the value as the zone lists it; already so: nothing sent', async () => {
  const { gladys, cloud } = await setup({ config: ALLOW });
  let ack = await set(gladys, ZONE, 'mode', 2);
  assert.equal(ack.success, true, ack.error);
  assert.equal(cloud.commands().at(-1).path, '/mobile/xxl_zones/234567/zone_mode');
  assert.deepEqual(cloud.commands().at(-1).body, { value: 'COOL' });
  await settle();
  assert.equal(state(gladys, ZONE, 'mode'), 2);
  ack = await set(gladys, ZONE, 'mode', 2);
  assert.equal(ack.success, true);
  assert.equal(cloud.commands().length, 1);
  for (const value of [7, -1, 1.5, 'HEAT', true]) {
    ack = await set(gladys, ZONE, 'mode', value);
    assert.equal(ack.success, false, String(value));
  }
  await running.stop();
  const ux = await setup({ house: 'issue_79891', config: ALLOW });
  ack = await set(ux.gladys, `ext:${SELECTOR}:zone:83261001`, 'mode', 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ux.cloud.commands().at(-1).body, { value: 'OFF' }, 'upper case, as the library');
});

test('fan mode: an option of the thermostat only', async () => {
  const { gladys, cloud } = await setup({ config: ALLOW });
  let ack = await set(gladys, THERMOSTAT, 'fan-mode', 'on');
  assert.equal(ack.success, true, ack.error);
  assert.equal(cloud.commands().at(-1).path, '/mobile/xxl_thermostats/345678/fan_mode');
  assert.deepEqual(cloud.commands().at(-1).body, { value: 'on' });
  ack = await set(gladys, THERMOSTAT, 'fan-mode', 'turbo');
  assert.equal(ack.success, false);
  assert.match(ack.error, /does not offer this fan mode/);
  ack = await set(gladys, THERMOSTAT, 'humidity', 40);
  assert.equal(ack.success, false);
  assert.match(ack.error, /read only/);
});

test('an offline thermostat: commands refused', async () => {
  const { gladys, cloud } = await setup({ house: 'system_offline', config: ALLOW });
  const ack = await set(gladys, `ext:${SELECTOR}:zone:83354736`, 'cool-setpoint', 74);
  assert.equal(ack.success, false);
  assert.match(ack.error, /offline/);
  assert.equal(cloud.commands().length, 0);
});

test('a slow fresh read: nothing sent past the budget', async () => {
  const { gladys, cloud, clock } = await setup({ config: ALLOW });
  cloud.onRequest = () => {
    clock.now += 3_000;
  };
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be checked in time|could not be read/);
  assert.equal(cloud.commands().length, 0);
});

test('a slow cloud: Gladys answered at 4.3 s, the state follows', async () => {
  const { gladys, cloud, timers } = await setup({ config: ALLOW });
  let release;
  cloud.hold = new Promise((resolve) => {
    release = resolve;
  });
  const pending = set(gladys, ZONE, 'heat-setpoint', 70);
  await settle();
  assert.ok(timers.delays().includes(COMMAND_ACK_MS));
  await timers.run((ms) => ms === COMMAND_ACK_MS);
  const ack = await pending;
  assert.equal(ack.success, true, 'answered while the cloud is still at work');
  cloud.hold = null;
  release();
  await settle();
  assert.equal(state(gladys, ZONE, 'heat-setpoint'), 70);
});

test('a slow command keeps its full timeout; a command meanwhile is refused at once', async () => {
  const { gladys, cloud, timers, logs, clock } = await setup({ config: ALLOW });
  cloud.hold = new Promise(() => {}); // never answers: the request times out
  const first = set(gladys, ZONE, 'heat-setpoint', 70);
  await settle();
  const post = cloud.commands().at(-1);
  assert.equal(post.timeoutMs, TIMEOUTS.REQUEST, 'not cut at the 3.5 s budget');
  await timers.run((ms) => ms === COMMAND_ACK_MS);
  assert.equal((await first).success, true, 'sent: Gladys answered at 4.3 s');
  // A second command while the first is still in flight: refused at once
  // (no timer to run, no waiting), nothing sent, never run later.
  const second = await set(gladys, ZONE, 'cool-setpoint', 76);
  assert.equal(second.success, false);
  assert.match(second.error, /previous command is still being applied by the cloud/);
  assert.match(second.error, /encore en cours dans le cloud/);
  assert.equal(cloud.commands().length, 1);
  cloud.hold = null;
  clock.now += TIMEOUTS.REQUEST;
  await timers.run((ms) => ms === TIMEOUTS.REQUEST);
  await settle();
  assert.ok(logs.some((l) => /not confirmed: timeout/.test(l)));
  assert.ok(timers.delays().includes(INTERVALS.AFTER_COMMAND_MS), 'read again soon');
  assert.equal(cloud.commands().length, 1, 'the refused command never ran');
  // Once the first one is over, a new command goes through.
  const third = await set(gladys, ZONE, 'cool-setpoint', 76);
  assert.equal(third.success, true, third.error);
  assert.equal(cloud.commands().length, 2);
});

test('the connection drops during a command: "may not have reached it", read again soon', async () => {
  const { gladys, cloud, timers } = await setup({ config: ALLOW });
  cloud.onRequest = (r) => {
    if (r.method === 'POST') cloud.unreachable = true;
  };
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.match(ack.error, /may not have reached it/);
  assert.ok(timers.delays().includes(INTERVALS.AFTER_COMMAND_MS));
});
test('a UX360 zone without its own address: refused, never an xxl_zones path', async () => {
  const house = fixture('two_ux360_multizone');
  const zone = house.result._links.child[0].data.items[0].zones[0];
  for (const f of zone.features) delete f.actions;
  const cloud = createFakeCloud({ house });
  const { gladys } = await setup({ cloud, house: 'two_ux360_multizone', config: ALLOW });
  const id = `ext:${SELECTOR}:zone:0000000001_1`;
  let ack = await set(gladys, id, 'heat-setpoint', 64);
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing was sent/);
  ack = await set(gladys, id, 'mode', 1);
  assert.equal(ack.success, false);
  assert.equal(cloud.commands().length, 0);
});

test('an address on another brand host: same path, the host of the brand chosen', async () => {
  const cloud = createFakeCloud({ house: 'issue_79891', root: 'https://www.tranehome.com' });
  const { gladys } = await setup({
    cloud,
    house: 'issue_79891',
    config: { ...ALLOW, brand: 'trane' },
  });
  const ack = await set(gladys, `ext:${SELECTOR}:zone:83261001`, 'heat-setpoint', 21);
  assert.equal(ack.success, true, ack.error);
  assert.equal(
    cloud.commands().at(-1).path,
    '/mobile/diagnostics/thermostats/2222249/setpoints/83261001',
  );
});

test('no deadband given: setpoint commands refused', async () => {
  const house = fixture(XL);
  const t = house.result._links.child[0].data.items[0];
  for (const f of [...t.features, ...t.zones[0].features]) delete f.setpoint_delta;
  const cloud = createFakeCloud({ house });
  const { gladys } = await setup({ cloud, config: ALLOW });
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.match(ack.error, /deadband of this thermostat are unknown/);
  assert.equal(cloud.commands().length, 0);
});

test('a 429 met by a command pauses every path', async () => {
  const { gladys, cloud, timers } = await setup({ config: ALLOW });
  cloud.failures.push({ match: (r) => r.method === 'POST', status: 429, retryAfterMs: 300_000 });
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [300_000]);
});

test('commands run one after the other', async () => {
  const { gladys, cloud } = await setup({ config: ALLOW });
  const [a, b] = await Promise.all([
    set(gladys, ZONE, 'heat-setpoint', 66),
    set(gladys, ZONE, 'cool-setpoint', 76),
  ]);
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(
    cloud.commands().map((r) => r.body),
    [
      { heat: 66, cool: 73 },
      { heat: 66, cool: 76 },
    ],
  );
});

test('commands turned off again: refused at once', async () => {
  const { gladys, cloud } = await setup({ config: ALLOW });
  await gladys.fake.configUpdated({ ...BASE_CONFIG, allow_control: false });
  const ack = await set(gladys, ZONE, 'heat-setpoint', 70);
  assert.equal(ack.success, false);
  assert.equal(cloud.commands().length, 0);
});
