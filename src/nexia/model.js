// -----------------------------------------------------------------------------
// The house JSON of the cloud, read into plain thermostats and zones (pure).
// Ported from the nexia library (bdraco/nexia: home.py, thermostat.py,
// zone.py, Apache-2.0): where the values are, the fallbacks between the
// XL-series ("xxl_thermostat") and UX360 ("faceplate_thermostat") layouts,
// the zone ids, the "calling" state of a zone, the hold / schedule labels.
//
// Nothing here trusts the JSON: a missing or odd field gives null, an id that
// cannot be an external id leaves its thermostat or zone out.
// -----------------------------------------------------------------------------

import { DEFAULT_DEADBAND, ID_PATTERN, LIMITS } from '../constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value.filter(isObject) : []);
const find = (items, key, value) => list(items).find((item) => item[key] === value) ?? null;
const text = (value, max = 100) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** A finite number from a number or a numeric string ("64"), else null ("--"). */
export function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const percent = (value) => {
  const n = num(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
};
/** A 0-1 ratio of the cloud as a percentage (0.35 -> 35). */
const ratio = (value) => {
  const n = num(value);
  return n !== null && n >= 0 && n <= 1 ? Math.round(n * 1000) / 10 : null;
};

/** The modes a zone may be in, as the app shows them. */
export const MODES = Object.freeze({
  OFF: 'OFF',
  HEAT: 'HEAT',
  COOL: 'COOL',
  AUTO: 'AUTO',
  EMERGENCY_HEAT: 'EMERGENCY_HEAT',
});

/** "heat", "HEAT", "emergency_heat"... -> MODES, else null (unknown). */
export function modeOf(value) {
  const key = text(value, 40)
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (key in MODES) return MODES[key];
  if (key === 'EM_HEAT' || key === 'EMERGENCYHEAT') return MODES.EMERGENCY_HEAT;
  return null;
}

/** An id of the cloud as it goes into an external id, or null. */
export function safeId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return ID_PATTERN.test(id) ? id : null;
}

/**
 * The zone id of the library (zone.py make_zone_id): the UX360 numbers its
 * zones 1, 2... per thermostat, so a small number is prefixed with the
 * thermostat id; any other id is unique already.
 */
export function zoneIdOf(thermostatId, rawId) {
  if (typeof rawId === 'number' && Number.isInteger(rawId) && rawId < 256) {
    return safeId(`${thermostatId}_${rawId}`);
  }
  return safeId(rawId);
}

/** The device entries of the house (home.py: groups expanded). */
export function deviceItemsOf(house) {
  const children = list(house?.result?._links?.child);
  const devices =
    children.find((c) => typeof c.href === 'string' && c.href.includes('/devices')) ?? children[0];
  const data = devices?.data;
  const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
  const out = [];
  for (const item of list(items)) {
    const type = item.type;
    if (!type || String(type).includes('thermostat')) {
      out.push(item);
    } else if (type === 'group') {
      for (const child of list(item._links?.child)) {
        if (isObject(child.data)) out.push(child.data);
      }
    }
  }
  return out;
}

/** `{ href, method }` of the first of `names` among `actions`, or null. */
function actionOf(actions, names) {
  if (!isObject(actions)) return null;
  for (const name of names) {
    const action = actions[name];
    if (isObject(action) && typeof action.href === 'string') {
      return {
        href: action.href,
        method: typeof action.method === 'string' ? action.method : 'POST',
      };
    }
  }
  return null;
}

/** The options of a setting or a feature, without the header line of the app. */
function optionsOf(options) {
  return list(options)
    .filter((o) => !o.header && (typeof o.value === 'string' || typeof o.value === 'number'))
    .map((o) => ({ value: o.value, label: text(o.label, 60) || String(o.value) }));
}

const limitsOf = (feature, fallback = {}) => ({
  heatMin: num(feature?.setpoint_heat_min) ?? fallback.heatMin ?? null,
  heatMax: num(feature?.setpoint_heat_max) ?? fallback.heatMax ?? null,
  coolMin: num(feature?.setpoint_cool_min) ?? fallback.coolMin ?? null,
  coolMax: num(feature?.setpoint_cool_max) ?? fallback.coolMax ?? null,
});

const HOLD_VALUES = new Set(['permanent_hold', 'hold']);

/**
 * One thermostat of the house: null when it cannot be shown (id, unit,
 * zones). `skipped` says why, for a log.
 */
export function parseThermostat(json) {
  const id = safeId(json?.id);
  if (!id) return { skipped: 'id' };
  const name = text(json.name) || `Thermostat ${id}`;
  const features = list(json.features);
  const settings = list(json.settings);
  const feature = (key) => find(features, 'name', key);
  const setting = (key) => find(settings, 'type', key);
  const main = feature('thermostat');
  const scale = text(main?.scale ?? setting('scale')?.current_value, 4).toUpperCase();
  const unit = scale === 'F' || scale === 'C' ? scale : null;
  if (!unit) return { skipped: 'unit', id, name };

  const systemStatus = text(json.system_status) || text(json.operating_state) || text(main?.status);
  const connected = json.connected !== false && systemStatus.toUpperCase() !== 'NOT CONNECTED';
  const advanced = list(feature('advanced_info')?.items);
  const model = text(find(advanced, 'label', 'Model')?.value, 60) || null;

  const fanSetting = setting('fan_mode');
  const fanFeature = feature('thermostat_fan_mode');
  const fanOptions = optionsOf(fanSetting?.options ?? fanFeature?.options).filter(
    (o) => typeof o.value === 'string',
  );
  const fanValue = fanSetting?.current_value ?? fanFeature?.value;
  const fan =
    fanOptions.length > 0
      ? {
          value: typeof fanValue === 'string' ? fanValue : null,
          options: fanOptions,
          // thermostat.py: the feature's own action first, then the setting's link.
          action:
            actionOf(fanFeature?.actions, ['self', 'update_thermostat_fan_mode']) ??
            actionOf(fanSetting?._links, ['self']),
        }
      : null;

  const thermostat = {
    id,
    rawId: json.id,
    name,
    model,
    unit,
    connected,
    systemStatus: systemStatus || null,
    humidity: json.indoor_humidity !== undefined ? percent(json.indoor_humidity) : null,
    hasHumidity: Boolean(json.has_indoor_humidity ?? json.indoor_humidity),
    hasOutdoor: Boolean(json.has_outdoor_temperature),
    outdoorTemperature: json.has_outdoor_temperature ? num(json.outdoor_temperature) : null,
    deadband: num(main?.setpoint_delta) ?? DEFAULT_DEADBAND[unit],
    limits: limitsOf(main),
    fan,
    hasHumidify: Boolean(setting('humidify')),
    humidify: ratio(setting('humidify')?.current_value),
    hasDehumidify: Boolean(setting('dehumidify')),
    dehumidify: ratio(setting('dehumidify')?.current_value),
    zones: [],
  };
  const systemMode = setting('system_mode') ?? setting('mode');
  for (const zone of list(json.zones).slice(0, LIMITS.ZONES)) {
    const parsed = parseZone(zone, thermostat, systemMode);
    if (parsed && !thermostat.zones.some((z) => z.id === parsed.id)) thermostat.zones.push(parsed);
  }
  if (thermostat.zones.length === 0) return { skipped: 'zones', id, name };
  return { thermostat };
}

function parseZone(json, thermostat, systemMode) {
  const id = zoneIdOf(thermostat.id, json.id);
  if (!id || safeId(json.id) === null) return null;
  const rawName = text(json.name);
  const native = rawName === 'NativeZone';
  const features = list(json.features);
  const settings = list(json.settings);
  const feature = (key) => find(features, 'name', key);
  const modeFeature = feature('thermostat_mode');
  const main = feature('thermostat');
  // zone.py get_current_mode: the zone setting, else the feature, else the
  // thermostat's system mode (zones without settings use the thermostat's).
  const zoneMode = settings.length > 0 ? find(settings, 'type', 'zone_mode') : systemMode;
  const requested = modeOf(modeFeature?.value) ?? modeOf(zoneMode?.current_value);
  const modeOptions = optionsOf(modeFeature?.options)
    .filter((o) => typeof o.value === 'string')
    .map((o) => ({ ...o, mode: modeOf(o.value) }))
    .filter((o) => o.mode !== null);

  const zoneStatus = text(json.zone_status);
  const operatingState = text(json.operating_state);
  let calling;
  if (native) {
    calling = Boolean(thermostat.systemStatus) && thermostat.systemStatus !== 'System Idle';
  } else if (zoneStatus.toLowerCase() === 'idle') {
    calling = false;
  } else if (['cooling', 'heating'].includes(zoneStatus.toLowerCase())) {
    calling = true;
  } else {
    calling = operatingState !== '' && operatingState !== 'Damper Closed';
  }

  // Run mode (hold or schedule): a setting, or a feature on the UX360.
  let runMode = null;
  for (const key of ['run_mode', 'thermostat_run_mode']) {
    const fromSetting = find(settings, 'type', key);
    if (fromSetting) {
      runMode = { value: fromSetting.current_value, options: fromSetting.options };
      break;
    }
    const fromFeature = feature(key);
    if (fromFeature) {
      runMode = { value: fromFeature.value, options: fromFeature.options };
      break;
    }
  }
  let setpointStatus = 'Permanent Hold';
  if (runMode) {
    const option = optionsOf(runMode.options).find((o) => o.value === runMode.value);
    setpointStatus = option?.label ?? (text(String(runMode.value ?? '')) || setpointStatus);
  }

  const setpoints = isObject(json.setpoints) ? json.setpoints : {};
  return {
    id,
    rawId: json.id,
    name: native ? thermostat.name : rawName || `Zone ${id}`,
    native,
    temperature: num(json.temperature),
    heat: num(setpoints.heat),
    cool: num(setpoints.cool),
    mode: requested,
    modeOptions,
    calling,
    zoneStatus: zoneStatus || null,
    setpointStatus,
    hold: runMode ? HOLD_VALUES.has(String(runMode.value)) : true,
    limits: limitsOf(main, thermostat.limits),
    deadband: num(main?.setpoint_delta) ?? thermostat.deadband,
    actions: {
      // zone.py: the feature's own action first, then the named one.
      setpoints: actionOf(main?.actions, ['self', 'set_setpoints']),
      mode: actionOf(modeFeature?.actions, ['self', 'update_thermostat_mode']),
    },
  };
}

/** Every thermostat of the house that can be shown, and why the others are not. */
export function thermostatsOf(house) {
  const thermostats = [];
  const skipped = [];
  for (const item of deviceItemsOf(house)) {
    const { thermostat, ...reason } = parseThermostat(item);
    if (thermostat) {
      if (!thermostats.some((t) => t.id === thermostat.id)) thermostats.push(thermostat);
    } else {
      skipped.push(reason);
    }
  }
  return { thermostats: thermostats.slice(0, LIMITS.THERMOSTATS), skipped };
}

/** climate.py hvac_action: what a zone does now. */
export function operatingStateOf(zone, thermostat) {
  if (zone.mode === MODES.OFF || !zone.calling) return 'IDLE';
  // The zone's own status first (UX360: "heating"), then the system's ("Cooling").
  for (const status of [zone.zoneStatus, thermostat.systemStatus]) {
    const words = String(status ?? '').toLowerCase();
    if (/\bcool/.test(words)) return 'COOLING';
    if (/\bheat/.test(words)) return 'HEATING';
  }
  return 'IDLE';
}
