// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the device types and the
// feature keys end up in user devices and scenes: never rename one
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/**
 * The brands of the nexia library (bdraco/nexia, const.py): the same cloud
 * under three addresses. The key is what the library calls the brand and what
 * the app sends in `X-AssociatedBrand`.
 */
export const BRANDS = Object.freeze({
  nexia: Object.freeze({ root: 'https://www.mynexia.com', label: 'Nexia (Trane)' }),
  trane: Object.freeze({ root: 'https://www.tranehome.com', label: 'Trane Home' }),
  asair: Object.freeze({ root: 'https://asairhome.com', label: 'American Standard Home (Asair)' }),
});

/** The app version the library sends (nexia const.py APP_VERSION). */
export const APP_VERSION = '6.0.0';
/** The name of this "phone" in the account (the library's device_name). */
export const DEVICE_NAME = 'Gladys Assistant';

/** `ext:<selector>:thermostat:<id>`: one per thermostat of the house. */
export const THERMOSTAT_TYPE = 'thermostat';
/** `ext:<selector>:zone:<zone id>`: one per zone of a thermostat. */
export const ZONE_TYPE = 'zone';

export const THERMOSTAT_FEATURES = Object.freeze({
  HUMIDITY: 'humidity',
  OUTDOOR_TEMPERATURE: 'outdoor-temperature',
  SYSTEM_STATUS: 'system-status',
  FAN_MODE: 'fan-mode',
  HUMIDIFY_SETPOINT: 'humidify-setpoint',
  DEHUMIDIFY_SETPOINT: 'dehumidify-setpoint',
});

export const ZONE_FEATURES = Object.freeze({
  TEMPERATURE: 'temperature',
  HEAT_SETPOINT: 'heat-setpoint',
  COOL_SETPOINT: 'cool-setpoint',
  MODE: 'mode',
  OPERATING_STATE: 'operating-state',
  SETPOINT_STATUS: 'setpoint-status',
});

/** THERMOSTAT_MODE of the core (server/utils/constants.js). */
export const THERMOSTAT_MODE = Object.freeze({ OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 });
/** THERMOSTAT_OPERATING_STATE of the core. */
export const THERMOSTAT_OPERATING_STATE = Object.freeze({ IDLE: 0, HEATING: 1, COOLING: 2 });

/** What an id from the cloud must look like to become an external id. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const LIMITS = Object.freeze({
  THERMOSTATS: 20,
  ZONES: 12,
  /** POST /state admits 300 states per minute per integration: we keep under. */
  STATES_PER_MINUTE: 250,
  /** Size cap of an answer of the cloud (a big house is about 0.5 MB). */
  MAX_BYTES: 4 * 1024 * 1024,
  /** Entries per publishTransports call (the SDK refuses more). */
  TRANSPORTS_PER_CALL: 100,
});

/**
 * Plausible setpoints, in the unit of the Gladys feature, checked on the raw
 * value BEFORE any conversion or rounding (a scene sending 22 to a °F feature
 * is refused, never taken as 22 °F). The thermostat's own limits are checked
 * after, in its unit.
 */
export const SETPOINT_BOUNDS = Object.freeze({
  fahrenheit: Object.freeze({ min: 40, max: 99 }),
  celsius: Object.freeze({ min: 4.5, max: 37 }),
});

/** The step of a setpoint: the library rounds to 1 °F and to 0.5 °C. */
export const SETPOINT_STEP = Object.freeze({ F: 1, C: 0.5 });

export const TIMEOUTS = Object.freeze({
  /** One request to the cloud (the library waits 20 s). */
  REQUEST: 20_000,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent to the cloud
 * (an action must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command request itself. */
export const COMMAND_MIN_SEND_MS = 800;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_500;
/** Once sent, Gladys gets its answer at the latest this long after the command arrived. */
export const COMMAND_ACK_MS = 4_300;

export const INTERVALS = Object.freeze({
  /** One reading of the house (Home Assistant reads every 120 s too). */
  POLL_MS: 120_000,
  /** A reading after a command (the library waits 7 s: the UX360 is slow to show it). */
  AFTER_COMMAND_MS: 10_000,
  /** Cloud unreachable: first retry (never faster than the reading), then doubling. */
  RETRY_MIN_MS: 120_000,
  RETRY_MAX_MS: 30 * 60_000,
  /** HTTP 429: pause of every request, within these bounds (Retry-After if given; never shorter than the reading). */
  BUSY_MIN_MS: 120_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** Least time between two logins; doubled when a fresh token is refused. */
  LOGIN_SPACING_MS: 5 * 60_000,
  LOGIN_SPACING_MAX_MS: 6 * 3600_000,
  /** A stable value is published again after this long (dated recently in Gladys). */
  HEARTBEAT_MS: 30 * 60_000,
  /** Least time between two sign-ins the user forces after a refusal (button, saved configuration). */
  FORCED_LOGIN_SPACING_MS: 60_000,
});

/**
 * E-mail or password refused: a few automatic tries, far apart (the library
 * warns that repeated failed logins may lock the account), then nothing until
 * the user saves the configuration or presses "Test the connection".
 */
export const REFUSED_RETRIES_MS = Object.freeze([6 * 3600_000, 24 * 3600_000]);
