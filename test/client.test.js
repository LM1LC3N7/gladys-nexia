// -----------------------------------------------------------------------------
// The cloud client against the fake cloud: login, session headers, 304,
// refused session and credentials, 429, the addresses of the commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTERVALS } from '../src/constants.js';
import { NexiaClient } from '../src/nexia/client.js';
import { CODES, NexiaError } from '../src/nexia/errors.js';
import { EMAIL, PASSWORD, createFakeCloud } from './helpers/fakeCloud.js';

const UUID = '6f1c1f6e-0f7e-4d3b-9c51-0e8a9a1b2c3d';

function setup({ password = PASSWORD, brand = 'nexia', cloud } = {}) {
  const clock = { now: Date.parse('2026-10-17T08:00:00Z') };
  cloud ??= createFakeCloud();
  const client = new NexiaClient({
    brand,
    email: EMAIL,
    password,
    deviceUuid: UUID,
    request: cloud.request,
    now: () => clock.now,
  });
  return { client, cloud, clock };
}

test('login, house, then 304 with the same session', async () => {
  const { client, cloud } = setup();
  const first = await client.house();
  assert.equal(first.changed, true);
  assert.equal(client.houseId, '123456');
  const signIn = cloud.requests[0];
  assert.equal(signIn.path, '/mobile/accounts/sign_in');
  assert.equal(signIn.body.login, EMAIL);
  assert.equal(signIn.body.device_uuid, UUID);
  assert.equal(signIn.body.app_version, '6.0.0');
  const second = await client.house();
  assert.equal(second.changed, false);
  assert.equal(second.json, first.json);
  assert.equal(cloud.logins, 1);
  assert.equal(cloud.requests.at(-1).headers['If-None-Match'], '"v1"');
});

test('a refused password is REFUSED, whatever the way the cloud says it', async () => {
  for (const failure of [
    null,
    { status: 401 },
    { status: 403 },
    { status: 422 },
    { status: 400 },
    { status: 302, location: 'https://www.mynexia.com/account/forgotten_credentials' },
  ]) {
    const cloud = createFakeCloud();
    if (failure) cloud.failures.push({ match: (r) => r.path.endsWith('sign_in'), ...failure });
    const { client } = setup({ password: failure ? PASSWORD : 'wrong', cloud });
    await assert.rejects(
      client.house(),
      (err) => err.code === CODES.REFUSED,
      String(failure?.status),
    );
    assert.equal(client.hasSession, false);
  }
});

test('a session refused long after the login: one new login', async () => {
  const { client, cloud, clock } = setup();
  await client.house();
  clock.now += 20 * 60_000;
  cloud.apiKey = 'expired';
  const { changed } = await client.house();
  assert.equal(cloud.logins, 2);
  assert.equal(changed, false, 'the house did not change: 304 after the new login');
});

test('a session refused right after the login: SESSION, the spacing doubles, no loop', async () => {
  const { client, cloud, clock } = setup();
  await client.house();
  cloud.failures.push({ match: (r) => r.method === 'GET', status: 401, once: false });
  await assert.rejects(client.house(), (err) => err.code === CODES.SESSION);
  assert.equal(cloud.logins, 1, 'no new login right after one');
  assert.equal(client.loginSpacing, 2 * INTERVALS.LOGIN_SPACING_MS);
  // Too early: no login at all.
  await assert.rejects(client.house(), (err) => err.code === CODES.SESSION && err.notSent);
  assert.equal(cloud.logins, 1);
  clock.now += 2 * INTERVALS.LOGIN_SPACING_MS;
  await assert.rejects(client.house(), (err) => err.code === CODES.SESSION);
  assert.equal(cloud.logins, 2);
  assert.equal(client.loginSpacing, 4 * INTERVALS.LOGIN_SPACING_MS);
  for (let i = 0; i < 10; i += 1) {
    clock.now += client.loginSpacing;
    await client.house().catch(() => {});
  }
  assert.equal(client.loginSpacing, INTERVALS.LOGIN_SPACING_MAX_MS, 'bounded to 6 h');
});

test('429 and 5xx are errors; 429 carries Retry-After', async () => {
  const { client, cloud } = setup();
  await client.house();
  cloud.failures.push({ match: () => true, status: 429, retryAfterMs: 90_000 });
  await assert.rejects(
    client.house(),
    (err) => err.code === CODES.RATE_LIMITED && err.retryAfterMs === 90_000,
  );
  cloud.failures.push({ match: () => true, status: 503 });
  await assert.rejects(client.house(), (err) => err.code === CODES.HTTP && err.status === 503);
});

test('command addresses stay on the cloud of the brand', () => {
  const { client } = setup();
  assert.deepEqual(
    client.resolve(
      {
        href: 'https://www.mynexia.com/mobile/diagnostics/thermostats/1/setpoints/1',
        method: 'put',
      },
      'xxl_zones/1/setpoints',
    ),
    { url: 'https://www.mynexia.com/mobile/diagnostics/thermostats/1/setpoints/1', method: 'PUT' },
  );
  for (const href of [
    'https://evil.example/mobile/x',
    'http://www.mynexia.com/mobile/x',
    'https://www.mynexia.com/admin/x',
    'https://user:pw@www.mynexia.com/mobile/x',
    'not a url',
  ]) {
    assert.equal(
      client.resolve({ href }, 'xxl_zones/9/setpoints').url,
      'https://www.mynexia.com/mobile/xxl_zones/9/setpoints',
      href,
    );
  }
  assert.equal(
    client.resolve({ href: 'https://www.mynexia.com/mobile/x', method: 'DELETE' }, 'a').method,
    'POST',
    'only POST and PUT',
  );
  const trane = setup({ brand: 'trane' }).client;
  assert.equal(trane.resolve(null, 'a').url, 'https://www.tranehome.com/mobile/a');
  // An address on another brand's host: the path kept, the host of the brand chosen.
  assert.equal(
    trane.resolve({ href: 'https://www.mynexia.com/mobile/diagnostics/thermostats/1/mode/1' }, null)
      .url,
    'https://www.tranehome.com/mobile/diagnostics/thermostats/1/mode/1',
  );
  assert.throws(
    () => trane.resolve(null, null),
    (err) => err.code === CODES.BAD_URL && err.notSent,
  );
});

test('sign-in: 408 and no connection are passing failures, the spacing is not used up', async () => {
  const { client, cloud } = setup();
  cloud.failures.push({ match: (r) => r.path.endsWith('sign_in'), status: 408 });
  await assert.rejects(client.house(), (err) => err.code === CODES.HTTP && err.status === 408);
  cloud.unreachable = true;
  await assert.rejects(client.house(), (err) => err.code === CODES.NETWORK);
  cloud.unreachable = false;
  await client.house();
  assert.equal(cloud.logins, 1, 'signed in at once after the passing failures (no spacing wait)');
});

test('an accepted sign-in that cannot be used: the spacing doubles, no login loop', async () => {
  const { client, cloud, clock } = setup();
  cloud.failures.push({
    match: (r) => r.path.endsWith('sign_in'),
    status: 200,
    body: { success: true, result: {} },
  });
  await assert.rejects(client.house(), (err) => err.code === CODES.BAD_ANSWER && err.retryAt > 0);
  assert.equal(client.loginSpacing, 2 * INTERVALS.LOGIN_SPACING_MS);
  await assert.rejects(client.house(), (err) => err.code === CODES.SESSION && err.notSent);
  assert.equal(cloud.logins, 0, 'the failure answered before the fake counted a login');
  clock.now += 2 * INTERVALS.LOGIN_SPACING_MS;
  // The house lookup refused right after the sign-in: doubled again.
  cloud.failures.push({ match: (r) => r.path.endsWith('/session'), status: 302 });
  await assert.rejects(client.house(), (err) => err.code === CODES.SESSION && err.status === 302);
  assert.equal(client.loginSpacing, 4 * INTERVALS.LOGIN_SPACING_MS);
});

test('the house lookup failed after the sign-in: looked up again, never /houses/null', async () => {
  const { client, cloud } = setup();
  cloud.failures.push({ match: (r) => r.path.endsWith('/session'), status: 500 });
  await assert.rejects(client.house(), (err) => err.code === CODES.HTTP);
  assert.equal(client.hasSession, true);
  await client.house();
  assert.equal(cloud.logins, 1, 'no new sign-in');
  assert.ok(cloud.requests.every((r) => !r.path.includes('null')));
});

test('send: the session and the origin are checked before anything leaves', async () => {
  const { client, cloud } = setup();
  await assert.rejects(
    client.send({ url: 'https://www.mynexia.com/mobile/x', method: 'POST', payload: {} }),
    (err) => err.code === CODES.SESSION && err.notSent,
  );
  await client.house();
  await assert.rejects(
    client.send({ url: 'https://evil.example/mobile/x', method: 'POST', payload: {} }),
    (err) => err instanceof NexiaError && err.code === CODES.BAD_URL,
  );
  const result = await client.send({
    url: 'https://www.mynexia.com/mobile/xxl_zones/234567/setpoints',
    method: 'POST',
    payload: { heat: 66, cool: 73 },
  });
  assert.equal(result.id, 234567);
  assert.equal(cloud.zone('234567').zone.setpoints.heat, 66);
});

test('a deadline already past: nothing is sent', async () => {
  const { client, cloud, clock } = setup();
  await assert.rejects(
    client.house({ deadline: clock.now - 1 }),
    (err) => err.code === CODES.DEADLINE,
  );
  assert.equal(cloud.requests.length, 0);
});
