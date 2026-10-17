// -----------------------------------------------------------------------------
// The configuration normalized, the persisted state repaired.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, credentialsKey, normalizeConfig } from '../src/config.js';
import { INTERVALS } from '../src/constants.js';
import { memoryStore, normalizeState } from '../src/store.js';

test('defaults, brand, trimmed e-mail, untouched password', () => {
  const config = normalizeConfig({ email: '  a@b.c ', password: ' secret ' });
  assert.equal(config.brand, 'nexia');
  assert.equal(config.email, 'a@b.c');
  assert.equal(config.password, ' secret ');
  assert.equal(config.allowControl, false, 'commands off by default');
  assert.equal(config.language, 'fr');
  assert.deepEqual(config.missing, []);
  assert.equal(normalizeConfig({ brand: 'asair' }).brand, 'asair');
  assert.equal(normalizeConfig({ brand: 'carrier' }).brand, 'nexia');
  assert.deepEqual(normalizeConfig({}).missing, ['email', 'password']);
  assert.equal(normalizeConfig({ email: 'nope', password: 'x' }).emailInvalid, true);
  assert.equal(normalizeConfig({ allow_control: 'true' }).allowControl, true);
  assert.equal(normalizeConfig(null).language, 'fr');
});

test('the account key: brand and e-mail hashed, never the password', () => {
  const a = normalizeConfig({ email: 'A@b.c', password: 'one' });
  const b = normalizeConfig({ email: 'a@b.c', password: 'two' });
  assert.equal(accountKey(a), accountKey(b));
  assert.match(accountKey(a), /^[0-9a-f]{32}$/);
  assert.notEqual(accountKey(a), accountKey({ ...a, brand: 'trane' }));
  assert.notEqual(credentialsKey(a), credentialsKey(b));
});

test('the persisted state is repaired and its waits capped', () => {
  const now = Date.parse('2026-10-17T08:00:00Z');
  const fresh = normalizeState(null, now);
  assert.match(fresh.deviceUuid, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.pausedUntil, 0);
  assert.equal(fresh.refusal, null);
  const kept = normalizeState(
    {
      deviceUuid: '6f1c1f6e-0f7e-4d3b-9c51-0e8a9a1b2c3d',
      pausedUntil: now + 365 * 86_400_000,
      refusal: { account: 'a'.repeat(32), tries: 2, nextAt: now + 365 * 86_400_000 },
    },
    now,
  );
  assert.equal(kept.deviceUuid, '6f1c1f6e-0f7e-4d3b-9c51-0e8a9a1b2c3d');
  assert.equal(kept.pausedUntil, now + INTERVALS.BUSY_MAX_MS);
  assert.equal(kept.refusal.nextAt, now + 24 * 3600_000);
  assert.equal(normalizeState({ refusal: { account: 'x' } }, now).refusal, null);
  assert.equal(
    normalizeState({ refusal: { account: 'b'.repeat(32), tries: 3, nextAt: null } }, now).refusal
      .nextAt,
    null,
  );
});

test('the memory store copies what it keeps', async () => {
  const store = memoryStore();
  assert.equal(await store.load(), null);
  const value = { a: 1 };
  await store.save(value);
  value.a = 2;
  assert.deepEqual(await store.load(), { a: 1 });
});
