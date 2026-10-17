// -----------------------------------------------------------------------------
// The house JSON read into thermostats and zones, on the test fixtures of the
// nexia library (bdraco/nexia, Apache-2.0, kept as published).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES,
  modeOf,
  num,
  operatingStateOf,
  parseThermostat,
  safeId,
  thermostatsOf,
  zoneIdOf,
} from '../src/nexia/model.js';
import { fixture } from './helpers/fakeCloud.js';

test('XL1050, one native zone: values, limits, fan, dehumidify', () => {
  const { thermostats, skipped } = thermostatsOf(fixture('single_zone_xl1050'));
  assert.deepEqual(skipped, []);
  const [t] = thermostats;
  assert.equal(t.id, '345678');
  assert.equal(t.unit, 'F');
  assert.equal(t.model, 'XL1050');
  assert.equal(t.humidity, 59);
  assert.equal(t.outdoorTemperature, 64, 'a numeric string');
  assert.equal(t.systemStatus, 'Cooling');
  assert.equal(t.deadband, 3);
  assert.deepEqual(t.limits, { heatMin: 55, heatMax: 90, coolMin: 60, coolMax: 99 });
  assert.deepEqual(
    t.fan.options.map((o) => o.value),
    ['auto', 'on', 'circulate'],
  );
  assert.equal(t.fan.value, 'circulate');
  assert.equal(t.dehumidify, 50);
  assert.equal(t.hasHumidify, false);
  const [z] = t.zones;
  assert.equal(z.id, '234567');
  assert.equal(z.native, true);
  assert.equal(z.name, 'Thermostat 1', 'a native zone takes the thermostat name');
  assert.equal(z.mode, MODES.AUTO);
  assert.deepEqual([z.temperature, z.heat, z.cool], [74, 68, 73]);
  assert.equal(z.calling, true);
  assert.equal(operatingStateOf(z, t), 'COOLING');
  assert.equal(z.actions.setpoints, null, 'no set_setpoints action: the fallback path');
  assert.equal(z.actions.mode.href, 'https://www.mynexia.com/mobile/xxl_zones/234567/zone_mode');
});

test('°C thermostats, XL824 and UX360 (faceplate) layouts', () => {
  const { thermostats } = thermostatsOf(fixture('issue_79891'));
  assert.deepEqual(
    thermostats.map((t) => [t.id, t.unit, t.deadband]),
    [
      ['2473073', 'C', 2],
      ['2222249', 'C', 2],
    ],
  );
  const ux = thermostats[1];
  assert.equal(ux.outdoorTemperature, null, 'has_outdoor_temperature but no value');
  const [z] = ux.zones;
  assert.equal(z.mode, MODES.AUTO, 'lower-case "auto"');
  assert.deepEqual(
    z.modeOptions.map((o) => [o.value, o.mode]),
    [
      ['off', 'OFF'],
      ['auto', 'AUTO'],
      ['cool', 'COOL'],
      ['heat', 'HEAT'],
    ],
  );
  assert.equal(z.actions.setpoints.method, 'PUT');
  assert.equal(z.limits.coolMin, 16, 'the zone limits first');
  assert.equal(z.setpointStatus, 'Run Schedule');
  assert.equal(z.hold, false);
});

test('UX360 zones numbered 1, 2...: the thermostat id prefixes them', () => {
  const { thermostats } = thermostatsOf(fixture('two_ux360_multizone'));
  assert.deepEqual(
    thermostats.flatMap((t) => t.zones.map((z) => z.id)),
    ['0000000001_1', '0000000001_2', '0000000001_3', '0000000002_1', '0000000002_2'],
  );
  const [t] = thermostats;
  assert.equal(operatingStateOf(t.zones[0], t), 'COOLING');
  assert.equal(operatingStateOf(t.zones[2], t), 'IDLE', 'zone_status "idle"');
});

test('groups expanded, offline thermostats, thermostats without zone left out', () => {
  assert.equal(thermostatsOf(fixture('grouped_xl850')).thermostats[0].id, '2323232');
  const offline = thermostatsOf(fixture('system_offline')).thermostats;
  assert.deepEqual(
    offline.map((t) => [t.id, t.connected]),
    [
      ['2224092', false],
      ['3887969', true],
      ['3295333', false],
    ],
  );
  assert.equal(offline[0].zones[0].heat, null, 'a null setpoint stays null');
  const { thermostats, skipped } = thermostatsOf(fixture('mobile_house_xl624'));
  assert.equal(thermostats.length, 2);
  assert.deepEqual(skipped, [{ skipped: 'zones', id: '1111111', name: 'Downstairs Hall' }]);
});

test('hostile or odd JSON: nothing thrown, odd ids left out', () => {
  assert.deepEqual(thermostatsOf(null), { thermostats: [], skipped: [] });
  assert.deepEqual(thermostatsOf({ result: { _links: { child: 'x' } } }).thermostats, []);
  assert.deepEqual(parseThermostat({ id: '../etc' }), { skipped: 'id' });
  assert.deepEqual(parseThermostat({ id: 1, name: 'x', features: [] }), {
    skipped: 'unit',
    id: '1',
    name: 'x',
  });
  const t = fixture('single_zone_xl1050').result._links.child[0].data.items[0];
  t.zones[0].id = 'a/b';
  assert.deepEqual(parseThermostat(t), { skipped: 'zones', id: '345678', name: 'Thermostat 1' });
  t.zones[0].id = 234567;
  t.indoor_humidity = '--';
  t.outdoor_temperature = '--';
  t.zones[0].temperature = 'n/a';
  const { thermostat } = parseThermostat(t);
  assert.equal(thermostat.humidity, null);
  assert.equal(thermostat.outdoorTemperature, null);
  assert.equal(thermostat.zones[0].temperature, null);
});

test('helpers', () => {
  assert.equal(num('64'), 64);
  assert.equal(num('--'), null);
  assert.equal(num(Infinity), null);
  assert.equal(modeOf('emergency_heat'), MODES.EMERGENCY_HEAT);
  assert.equal(modeOf('EM Heat'), MODES.EMERGENCY_HEAT);
  assert.equal(modeOf('fan only'), null);
  assert.equal(modeOf('Cool'), MODES.COOL);
  assert.equal(safeId(12), '12');
  assert.equal(safeId('a b'), null);
  assert.equal(zoneIdOf('T1', 2), 'T1_2');
  assert.equal(zoneIdOf('T1', 83496154), '83496154');
  assert.equal(zoneIdOf('T1', '2'), '2', 'only a number is prefixed (as the library)');
});
