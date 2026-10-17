// -----------------------------------------------------------------------------
// What must survive a restart of the container, in /data (the only writable
// place): the device uuid this installation signs in with (the library keeps
// it in a file too), the HTTP 429 pause, and a refusal of the e-mail or the
// password with its automatic retries. No secret is ever written here: the
// account is a hash of the brand and the e-mail, the session stays in memory.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { INTERVALS, REFUSED_RETRIES_MS } from './constants.js';

export const STATE_FILE = '/data/nexia-state.json';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[0-9a-f]{32}$/;
const MAX_REFUSAL_WAIT = Math.max(...REFUSED_RETRIES_MS);

export function fileStore(path = STATE_FILE) {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    async save(data) {
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(data));
      await rename(temporary, path);
    },
  };
}

/** A store in memory (tests, or /data not writable). */
export function memoryStore(initial = null) {
  let data = initial;
  return {
    async load() {
      return data === null ? null : JSON.parse(JSON.stringify(data));
    },
    async save(value) {
      data = JSON.parse(JSON.stringify(value));
    },
    get data() {
      return data;
    },
  };
}

const finite = (value) => (Number.isFinite(value) ? value : 0);

/**
 * The persisted state, repaired (never throws). The end of a pause or of a
 * refusal wait read back is capped: a clock or a file gone wrong never holds
 * the integration longer than the longest wait it could have chosen.
 */
export function normalizeState(raw, now) {
  const deviceUuid = typeof raw?.deviceUuid === 'string' && UUID.test(raw.deviceUuid);
  const refusal = raw?.refusal;
  return {
    deviceUuid: deviceUuid ? raw.deviceUuid : randomUUID(),
    // A 429 is the cloud's, whatever the account: the pause is not tied to one.
    pausedUntil: Math.min(finite(raw?.pausedUntil), now + INTERVALS.BUSY_MAX_MS),
    refusal:
      refusal && ACCOUNT.test(String(refusal.account))
        ? {
            account: refusal.account,
            tries: Math.max(1, Math.min(Math.trunc(finite(refusal.tries)), 100)),
            // When it was refused (never in the future).
            at: Math.min(finite(refusal.at), now),
            // null: no automatic try left.
            nextAt:
              refusal.nextAt === null
                ? null
                : Math.min(finite(refusal.nextAt), now + MAX_REFUSAL_WAIT),
          }
        : null,
  };
}
