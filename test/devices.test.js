// -----------------------------------------------------------------------------
// The Gladys devices: categories, types, units, bounds, the frozen keys, and
// the merge with the devices the user created.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  buildThermostatDevice,
  buildZoneDevice,
  convert,
  mergeWithCreated,
  parseExternalId,
  thermostatStates,
  zoneStates,
} from '../src/devices.js';
import { thermostatsOf } from '../src/nexia/model.js';
import { fixture } from './helpers/fakeCloud.js';

const gladys = createFakeGladys({ selector: 'nexia' });
const first = (name) => thermostatsOf(fixture(name)).thermostats[0];
const keys = (device) => device.features.map((f) => f.external_id.split(':').at(-1));

test('the thermostat device: humidity, outdoor probe, status, fan select, humidity targets', () => {
  const t = first('grouped_xl850');
  const device = buildThermostatDevice(gladys, t, 'en');
  assert.equal(device.external_id, 'ext:nexia:thermostat:2323232');
  assert.equal(device.name, 'Hallway Control (system)');
  assert.deepEqual(keys(device), [
    'humidity',
    'outdoor-temperature',
    'system-status',
    'fan-mode',
    'humidify-setpoint',
    'dehumidify-setpoint',
  ]);
  const byKey = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.equal(byKey.humidity.category, 'humidity-sensor');
  assert.equal(byKey['outdoor-temperature'].type, 'probe', 'kept out of the room temperature');
  assert.equal(byKey['outdoor-temperature'].unit, 'fahrenheit');
  assert.deepEqual(
    byKey['fan-mode'].supported_options.map((o) => [o.value, o.label]),
    [
      ['auto', 'Auto'],
      ['on', 'On'],
      ['circulate', 'Circulate'],
    ],
  );
  // Humidity targets are not measures: never humidity-sensor (room averages).
  assert.equal(byKey['humidify-setpoint'].category, 'unknown');
  assert.equal(byKey['humidify-setpoint'].unit, undefined);
  assert.deepEqual(
    thermostatStates(t).map(([k, v]) => [k, v.state ?? v.text]),
    [
      ['humidity', 40],
      ['outdoor-temperature', 80],
      ['system-status', 'Cooling'],
      ['fan-mode', 'circulate'],
      ['humidify-setpoint', 30],
      ['dehumidify-setpoint', 45],
    ],
  );
});

test('the zone device: temperature, setpoints within the limits, mode, state, hold', () => {
  const t = first('single_zone_xl1050');
  const device = buildZoneDevice(gladys, t, t.zones[0], 'fr');
  assert.equal(device.external_id, 'ext:nexia:zone:234567');
  assert.deepEqual(keys(device), [
    'temperature',
    'heat-setpoint',
    'cool-setpoint',
    'mode',
    'operating-state',
    'setpoint-status',
  ]);
  const [temperature, heat, cool, mode, operating] = device.features;
  assert.equal(temperature.category, 'temperature-sensor');
  assert.equal(temperature.type, 'decimal');
  assert.deepEqual(
    [heat.category, heat.type, heat.unit, heat.min, heat.max, heat.read_only],
    ['thermostat', 'target-temperature', 'fahrenheit', 55, 90, false],
  );
  assert.equal(heat.step, 1);
  // The cooling setpoint: air-conditioning, the one the HomeKit bridge reads as the cooling threshold.
  assert.deepEqual(
    [cool.category, cool.type, cool.unit, cool.min, cool.max, cool.step],
    ['air-conditioning', 'target-temperature', 'fahrenheit', 60, 99, 1],
  );
  assert.equal(mode.max, 3);
  const heatOnly = {
    ...t.zones[0],
    modeOptions: t.zones[0].modeOptions.filter((o) => ['OFF', 'HEAT'].includes(o.mode)),
  };
  const limited = buildZoneDevice(gladys, t, heatOnly, 'fr').features.find((f) =>
    f.external_id.endsWith(':mode'),
  );
  assert.equal(limited.max, 1, 'the highest mode offered');
  assert.deepEqual(
    mode.supported_options.map((o) => [o.value, o.label]),
    [
      [0, 'Arrêt'],
      [1, 'Chauffage'],
      [2, 'Refroidissement'],
      [3, 'Auto'],
    ],
  );
  assert.equal(mode.unit, undefined, 'enums carry no unit');
  assert.equal(operating.unit, undefined);
  assert.equal(operating.read_only, true);
  const states = Object.fromEntries(
    zoneStates(t, t.zones[0]).map(([k, v]) => [k, v.state ?? v.text]),
  );
  assert.deepEqual(states, {
    temperature: 74,
    'heat-setpoint': 68,
    'cool-setpoint': 73,
    mode: 3,
    'operating-state': 2,
    'setpoint-status': 'Permanent Hold',
  });
});

test('°C: units and bounds in °C', () => {
  const t = first('issue_79891');
  const device = buildZoneDevice(gladys, t, t.zones[0], 'en');
  const heat = device.features.find((f) => f.external_id.endsWith(':heat-setpoint'));
  assert.deepEqual([heat.unit, heat.min, heat.max, heat.step], ['celsius', 13, 32, 0.5]);
});

test('conversions', () => {
  assert.equal(convert(26, 'C', 'F'), 78.8);
  assert.equal(convert(72, 'F', 'C'), 22.2);
  assert.equal(convert(72, 'F', 'F'), 72);
  assert.equal(convert(null, 'F', 'C'), null);
});

test('a created device keeps its features as created; new ones are added', () => {
  const t = first('single_zone_xl1050');
  const built = buildZoneDevice(gladys, t, t.zones[0], 'en');
  const created = JSON.parse(JSON.stringify(built));
  created.features = created.features.filter((f) => !f.external_id.endsWith(':setpoint-status'));
  created.features[0].unit = 'celsius';
  created.features.push({
    external_id: 'ext:nexia:zone:234567:old',
    name: 'Old',
    category: 'text',
    type: 'text',
    read_only: true,
  });
  const merged = mergeWithCreated(built, created);
  assert.equal(merged.features[0].unit, 'celsius', 'the unit as created');
  assert.ok(
    merged.features.some((f) => f.external_id.endsWith(':old')),
    'never lost',
  );
  assert.ok(
    merged.features.some((f) => f.external_id.endsWith(':setpoint-status')),
    'added',
  );
  assert.deepEqual(mergeWithCreated(built, undefined), built);
});

test('external ids', () => {
  assert.deepEqual(parseExternalId(gladys, 'ext:nexia:zone:0000000001_2:mode'), {
    kind: 'zone',
    id: '0000000001_2',
    feature: 'mode',
  });
  assert.deepEqual(parseExternalId(gladys, 'ext:nexia:thermostat:345678'), {
    kind: 'thermostat',
    id: '345678',
    feature: null,
  });
  assert.equal(parseExternalId(gladys, 'ext:nexia:zone:1:mode:x'), null);
  assert.equal(parseExternalId(gladys, 'ext:other:zone:1'), null);
  assert.equal(parseExternalId(gladys, 42), null);
});
