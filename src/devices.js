// -----------------------------------------------------------------------------
// Gladys devices and their states (pure).
//
//   thermostat  `ext:<selector>:thermostat:<thermostat id>`
//               the system: indoor humidity, outdoor temperature (a probe,
//               kept out of the room temperature), system status, fan mode
//               (a command), humidify / dehumidify setpoints (read only)
//   zone        `ext:<selector>:zone:<zone id>`
//               one per zone (a single-zone system has one "native" zone):
//               temperature, heating and cooling setpoints (commands), mode
//               (a command: off, heating, cooling, auto), operating state,
//               schedule or hold
//
// The ids are those of the cloud (the zone id built like the library's,
// see nexia/model.js zoneIdOf), never a name or a position.
//
// Never a `switch` nor a writable `binary`: the core hands every switch to
// the voice assistants, MCP and the "turn everything off" scene actions.
// The commands (setpoints, zone mode, fan mode) are refused unless the user
// allowed them (`allow_control`, off by default).
//
// Units: a feature takes the unit of the thermostat when it is created (°F
// or °C, both listed by the core for these categories); a value is always
// converted to the unit of the feature as it was CREATED in Gladys (units
// are fixed at creation), whatever the thermostat reports later.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  BRANDS,
  ID_PATTERN,
  SETPOINT_BOUNDS,
  THERMOSTAT_FEATURES as TF,
  THERMOSTAT_MODE,
  THERMOSTAT_OPERATING_STATE,
  THERMOSTAT_TYPE,
  ZONE_FEATURES as ZF,
  ZONE_TYPE,
} from './constants.js';
import { MODES, operatingStateOf } from './nexia/model.js';
import { texts } from './i18n.js';

export const thermostatIds = (gladys, id) => gladys.externalIds(THERMOSTAT_TYPE, id);
export const zoneIds = (gladys, id) => gladys.externalIds(ZONE_TYPE, id);

/** The Gladys unit of a thermostat unit ('F' / 'C'). */
export const gladysUnit = (unit) => (unit === 'C' ? U.CELSIUS : U.FAHRENHEIT);
/** The thermostat unit of a Gladys unit, or null for any other unit. */
export const nexiaUnit = (unit) => (unit === U.CELSIUS ? 'C' : unit === U.FAHRENHEIT ? 'F' : null);
export const unitSymbol = (unit) => (unit === 'C' || unit === U.CELSIUS ? '°C' : '°F');

/** A temperature from one unit ('F' / 'C') to another, to 0.1 degree. */
export function convert(value, from, to) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (from === to) return value;
  const converted = from === 'F' ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
  return Math.round(converted * 10) / 10;
}

/** THERMOSTAT_MODE of a zone mode (emergency heat is heating; unknown: null). */
export const modeValue = (mode) =>
  ({
    [MODES.OFF]: THERMOSTAT_MODE.OFF,
    [MODES.HEAT]: THERMOSTAT_MODE.HEATING,
    [MODES.EMERGENCY_HEAT]: THERMOSTAT_MODE.HEATING,
    [MODES.COOL]: THERMOSTAT_MODE.COOLING,
    [MODES.AUTO]: THERMOSTAT_MODE.AUTO,
  })[mode] ?? null;

/** The zone mode a THERMOSTAT_MODE command asks for. */
export const MODE_OF_VALUE = Object.freeze({
  [THERMOSTAT_MODE.OFF]: MODES.OFF,
  [THERMOSTAT_MODE.HEATING]: MODES.HEAT,
  [THERMOSTAT_MODE.COOLING]: MODES.COOL,
  [THERMOSTAT_MODE.AUTO]: MODES.AUTO,
});

/** What a fan mode value of the cloud must look like to become a select option. */
const OPTION_VALUE = /^[A-Za-z0-9_-]{1,40}$/;

const sensor = (extra) => ({ read_only: true, has_feedback: false, keep_history: true, ...extra });
const command = (extra) => ({ read_only: false, has_feedback: true, keep_history: true, ...extra });
const words = () =>
  sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

/** The bounds of a setpoint feature, in its unit: the thermostat's limits within the plausible ones. */
function setpointRange(min, max, unit) {
  const bounds = SETPOINT_BOUNDS[gladysUnit(unit)];
  const low = convert(min, unit, unit) ?? bounds.min;
  const high = convert(max, unit, unit) ?? bounds.max;
  return {
    min: Math.max(bounds.min, Math.min(low, bounds.max)),
    max: Math.min(bounds.max, Math.max(high, bounds.min)),
  };
}

export function fanOptions(thermostat) {
  return (thermostat.fan?.options ?? []).filter((o) => OPTION_VALUE.test(o.value));
}

export function buildThermostatDevice(gladys, thermostat, language, brand = 'nexia') {
  const ids = thermostatIds(gladys, thermostat.id);
  const t = texts(language);
  const named = (key, feature) => ({
    name: t.features[key],
    external_id: ids.feature(key),
    ...feature,
  });
  const features = [];
  if (thermostat.hasHumidity) {
    features.push(
      named(
        TF.HUMIDITY,
        sensor({
          category: C.HUMIDITY_SENSOR,
          type: T.SENSOR.DECIMAL,
          unit: U.PERCENT,
          min: 0,
          max: 100,
        }),
      ),
    );
  }
  if (thermostat.hasOutdoor) {
    // A probe: the core keeps it out of the temperature of the room the
    // thermostat is in.
    features.push(
      named(
        TF.OUTDOOR_TEMPERATURE,
        sensor({
          category: C.TEMPERATURE_SENSOR,
          type: T.TEMPERATURE_SENSOR.PROBE,
          unit: gladysUnit(thermostat.unit),
          min: thermostat.unit === 'C' ? -50 : -58,
          max: thermostat.unit === 'C' ? 60 : 140,
        }),
      ),
    );
  }
  features.push(named(TF.SYSTEM_STATUS, words()));
  const fan = fanOptions(thermostat);
  if (fan.length > 0) {
    features.push(
      named(
        TF.FAN_MODE,
        command({
          category: C.TEXT,
          type: T.TEXT.SELECT,
          keep_history: false,
          supported_options: fan.map((o, i) => ({
            value: o.value,
            label: t.fan[o.value.toLowerCase()] ?? o.label,
            sort_order: i,
          })),
        }),
      ),
    );
  }
  // Humidity TARGETS, not measures: never humidity-sensor (the core averages
  // every humidity-sensor of a room into its humidity).
  for (const [key, has] of [
    [TF.HUMIDIFY_SETPOINT, thermostat.hasHumidify],
    [TF.DEHUMIDIFY_SETPOINT, thermostat.hasDehumidify],
  ]) {
    if (has) {
      features.push(
        named(key, sensor({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 })),
      );
    }
  }
  return {
    name: t.thermostat(thermostat.name),
    external_id: ids.device,
    model: thermostat.model ?? BRANDS[brand]?.label ?? 'Nexia',
    should_poll: false,
    features,
  };
}

export function buildZoneDevice(gladys, thermostat, zone, language) {
  const ids = zoneIds(gladys, zone.id);
  const t = texts(language);
  const unit = thermostat.unit;
  const named = (key, feature) => ({
    name: t.features[key],
    external_id: ids.feature(key),
    ...feature,
  });
  const features = [
    named(
      ZF.TEMPERATURE,
      sensor({
        category: C.TEMPERATURE_SENSOR,
        type: T.SENSOR.DECIMAL,
        unit: gladysUnit(unit),
        min: unit === 'C' ? -20 : -4,
        max: unit === 'C' ? 60 : 140,
      }),
    ),
  ];
  // Commands, refused unless the user allowed them (`allow_control`, off by
  // default): read_only is fixed when the device is created, so the
  // permission is checked at each command instead.
  for (const [key, min, max] of [
    [ZF.HEAT_SETPOINT, zone.limits.heatMin, zone.limits.heatMax],
    [ZF.COOL_SETPOINT, zone.limits.coolMin, zone.limits.coolMax],
  ]) {
    features.push(
      named(
        key,
        command({
          category: C.THERMOSTAT,
          type: T.THERMOSTAT.TARGET_TEMPERATURE,
          unit: gladysUnit(unit),
          ...setpointRange(min, max, unit),
        }),
      ),
    );
  }
  const offered =
    zone.modeOptions.length > 0
      ? zone.modeOptions.map((o) => o.mode)
      : Object.values(MODE_OF_VALUE);
  const modes = Object.entries(MODE_OF_VALUE).filter(([, mode]) => offered.includes(mode));
  if (modes.length > 0 && (zone.mode !== null || zone.modeOptions.length > 0)) {
    features.push(
      named(
        ZF.MODE,
        command({
          category: C.THERMOSTAT,
          type: T.THERMOSTAT.MODE,
          min: THERMOSTAT_MODE.OFF,
          max: THERMOSTAT_MODE.AUTO,
          supported_options: modes.map(([value, mode], i) => ({
            value: Number(value),
            label: t.modes[mode],
            sort_order: i,
          })),
        }),
      ),
    );
  }
  features.push(
    named(
      ZF.OPERATING_STATE,
      sensor({ category: C.THERMOSTAT, type: T.THERMOSTAT.OPERATING_STATE, min: 0, max: 2 }),
    ),
    named(ZF.SETPOINT_STATUS, words()),
  );
  return {
    name: t.zone(zone.name),
    external_id: ids.device,
    model: thermostat.model ?? 'Nexia zone',
    should_poll: false,
    features,
  };
}

/**
 * A device as it is published again: a device the user created keeps every
 * feature it was created with, as it was created (category, type, unit,
 * bounds and options are fixed in Gladys; a change or a missing feature
 * marks the device "structure changed", and "Update" would destroy the
 * history). New features are added after them.
 */
export function mergeWithCreated(built, created) {
  if (!created || !Array.isArray(created.features)) return built;
  const builtFeatures = new Map(built.features.map((f) => [f.external_id, f]));
  const features = created.features
    .filter((f) => typeof f?.external_id === 'string')
    .map((f) => {
      const fresh = builtFeatures.get(f.external_id);
      const kept = {
        name: fresh?.name ?? f.name,
        external_id: f.external_id,
        category: f.category,
        type: f.type,
        read_only: f.read_only,
        has_feedback: f.has_feedback,
        keep_history: f.keep_history,
      };
      for (const key of ['unit', 'min', 'max', 'supported_options']) {
        if (f[key] !== undefined && f[key] !== null) kept[key] = f[key];
      }
      return kept;
    });
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of built.features) {
    if (!known.has(feature.external_id)) features.push(feature);
  }
  return { ...built, features };
}

/**
 * What an external id of this integration designates:
 * { kind: 'thermostat' | 'zone', id, feature } or null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  for (const [kind, type] of [
    ['thermostat', THERMOSTAT_TYPE],
    ['zone', ZONE_TYPE],
  ]) {
    const prefix = gladys.externalId(`${type}:`);
    if (externalId.startsWith(prefix)) {
      const [id, feature, ...rest] = externalId.slice(prefix.length).split(':');
      if (rest.length > 0 || !ID_PATTERN.test(id ?? '')) return null;
      return { kind, id, feature: feature ?? null };
    }
  }
  return null;
}

/** The devices the user created, by external id (gladys.devices, kept up to date by the SDK). */
export function createdDevices(gladys) {
  const map = new Map();
  for (const device of gladys.devices ?? []) {
    if (typeof device?.external_id === 'string') map.set(device.external_id, device);
  }
  return map;
}

/** The states of a thermostat: [key, { state } | { text }, temperature?]. */
export function thermostatStates(thermostat) {
  const states = [];
  const add = (key, value, temperature = false) => {
    if (value !== null && value !== undefined) states.push([key, value, temperature]);
  };
  add(TF.HUMIDITY, thermostat.humidity === null ? null : { state: thermostat.humidity });
  add(
    TF.OUTDOOR_TEMPERATURE,
    thermostat.outdoorTemperature === null ? null : { state: thermostat.outdoorTemperature },
    true,
  );
  add(TF.SYSTEM_STATUS, thermostat.systemStatus ? { text: thermostat.systemStatus } : null);
  const fan = thermostat.fan?.value;
  add(TF.FAN_MODE, typeof fan === 'string' && OPTION_VALUE.test(fan) ? { text: fan } : null);
  add(TF.HUMIDIFY_SETPOINT, thermostat.humidify === null ? null : { state: thermostat.humidify });
  add(
    TF.DEHUMIDIFY_SETPOINT,
    thermostat.dehumidify === null ? null : { state: thermostat.dehumidify },
  );
  return states;
}

/** The states of a zone: [key, { state } | { text }, temperature?]. */
export function zoneStates(thermostat, zone) {
  const states = [];
  const add = (key, value, temperature = false) => {
    if (value !== null && value !== undefined) states.push([key, value, temperature]);
  };
  add(ZF.TEMPERATURE, zone.temperature === null ? null : { state: zone.temperature }, true);
  add(ZF.HEAT_SETPOINT, zone.heat === null ? null : { state: zone.heat }, true);
  add(ZF.COOL_SETPOINT, zone.cool === null ? null : { state: zone.cool }, true);
  const mode = modeValue(zone.mode);
  add(ZF.MODE, mode === null ? null : { state: mode });
  add(ZF.OPERATING_STATE, {
    state: THERMOSTAT_OPERATING_STATE[operatingStateOf(zone, thermostat)],
  });
  add(ZF.SETPOINT_STATUS, zone.setpointStatus ? { text: zone.setpointStatus } : null);
  return states;
}
