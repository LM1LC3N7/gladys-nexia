// -----------------------------------------------------------------------------
// A fake Nexia cloud: the `request` function of src/nexia/http.js, in memory.
// It serves the houses of the nexia library's test fixtures, checks the
// session headers, answers 304 to a matching If-None-Match, and applies the
// commands to its house so the next reading shows them.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { NexiaError } from '../../src/nexia/errors.js';

export const EMAIL = 'someone@example.com';
export const PASSWORD = 'p4ss word';
export const HOUSE_ID = '123456';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));

const json = (status, body, headers = {}) => ({
  status,
  etag: headers.etag,
  location: headers.location,
  retryAfterMs: headers.retryAfterMs,
  json: body,
});

/** The thermostat items of a house fixture (groups expanded), by reference. */
export function itemsOf(house) {
  const data = house.result._links.child[0].data;
  const out = [];
  for (const item of data.items) {
    if (item.type === 'group') out.push(...item._links.child.map((c) => c.data));
    else out.push(item);
  }
  return out;
}

export function createFakeCloud({
  house = 'single_zone_xl1050',
  root = 'https://www.mynexia.com',
} = {}) {
  const cloud = {
    root,
    email: EMAIL,
    password: PASSWORD,
    house: typeof house === 'string' ? fixture(house) : house,
    version: 1,
    apiKey: null,
    logins: 0,
    requests: [],
    /** Queued answers: { match(request) -> bool, status, retryAfterMs?, once? }. */
    failures: [],
    /** Timers of the test: a held command times out on them after its timeoutMs. */
    timers: null,
    /** A promise the next command waits for (slow cloud). */
    hold: null,
    /** Called on every request (a test advances its clock there). */
    onRequest: null,
    /** What a command answers: 'zone' (the zone JSON, like the XL series) or 'short'. */
    commandAnswer: 'zone',
    unreachable: false,
    get etag() {
      return `"v${cloud.version}"`;
    },
    touch() {
      cloud.version += 1;
    },
    thermostat(id) {
      return itemsOf(cloud.house).find((t) => String(t.id) === String(id));
    },
    zone(rawId) {
      for (const t of itemsOf(cloud.house)) {
        const zone = (t.zones ?? []).find((z) => String(z.id) === String(rawId));
        if (zone) return { thermostat: t, zone };
      }
      return null;
    },
    commands: () =>
      cloud.requests.filter((r) => r.method !== 'GET' && !/sign_in|session$/.test(r.path)),
  };

  async function request({ method, url, headers, body, timeoutMs, onSent }) {
    const parsed = new URL(url);
    const entry = { method, path: parsed.pathname, headers, body, timeoutMs };
    cloud.requests.push(entry);
    await cloud.onRequest?.(entry);
    if (cloud.unreachable) {
      throw new NexiaError('network', { notSent: true });
    }
    onSent?.();
    const failure = cloud.failures.find((f) => f.match(entry));
    if (failure) {
      if (failure.once !== false) cloud.failures.splice(cloud.failures.indexOf(failure), 1);
      return json(failure.status, failure.body ?? null, {
        retryAfterMs: failure.retryAfterMs,
        location: failure.location,
      });
    }
    if (parsed.origin !== cloud.root) return json(404, null);
    const path = parsed.pathname;
    if (method === 'POST' && path === '/mobile/accounts/sign_in') {
      cloud.logins += 1;
      if (body?.login !== cloud.email || body?.password !== cloud.password) {
        return json(200, { success: false, error: 'Invalid credentials', result: null });
      }
      cloud.apiKey = `key-${cloud.logins}`;
      return json(200, {
        success: true,
        error: null,
        result: { mobile_id: 5400 + cloud.logins, api_key: cloud.apiKey, setup_step: 'done' },
      });
    }
    const authorized = headers['X-ApiKey'] === cloud.apiKey && cloud.apiKey !== null;
    if (!authorized) {
      return json(302, undefined, { location: `${cloud.root}/login` });
    }
    if (method === 'POST' && path === '/mobile/session') {
      const session = fixture('mobile_session');
      session.result._links.child[0].data.id = Number(HOUSE_ID);
      session.result._links.child[0].data.name = 'My home';
      return json(200, session);
    }
    if (method === 'GET' && path === `/mobile/houses/${HOUSE_ID}`) {
      if (headers['If-None-Match'] === cloud.etag) return json(304, null, { etag: cloud.etag });
      return json(200, JSON.parse(JSON.stringify(cloud.house)), { etag: cloud.etag });
    }
    if (method === 'POST' || method === 'PUT') {
      if (cloud.hold) {
        // A slow cloud: the request times out like the real one (timeoutMs), on the test's timers.
        let handle;
        const timedOut = new Promise((_, reject) => {
          handle = cloud.timers?.setTimeout(() => reject(new NexiaError('timeout')), timeoutMs);
        });
        try {
          await Promise.race([cloud.hold, timedOut]);
        } finally {
          cloud.timers?.clearTimeout(handle);
        }
      }
      return command(path, body);
    }
    return json(404, null);
  }

  function command(path, body) {
    // XL series: /xxl_zones/<zone id>/<setting>; UX360: /diagnostics/thermostats/<id>/<setting>/<n>.
    const xl = /\/xxl_zones\/(\w+)\/(setpoints|zone_mode)$/.exec(path);
    const ux = /\/diagnostics\/thermostats\/(\w+)\/(setpoints|mode)\/(\w+)$/.exec(path);
    if (xl || ux) {
      let zone;
      if (xl) {
        zone = cloud.zone(xl[1])?.zone;
      } else {
        const zones = cloud.thermostat(ux[1])?.zones ?? [];
        zone = zones.find((z) => String(z.id) === ux[3]) ?? zones[Number(ux[3]) - 1];
      }
      if (!zone) return json(404, null);
      if (/setpoints/.test(path)) {
        zone.setpoints = { heat: body.heat, cool: body.cool };
      } else {
        const feature = zone.features.find((f) => f.name === 'thermostat_mode');
        feature.value = body.value;
      }
      cloud.touch();
      return json(200, {
        success: true,
        result: cloud.commandAnswer === 'zone' ? JSON.parse(JSON.stringify(zone)) : { ok: 1 },
      });
    }
    const match = /\/(?:xxl_thermostats|diagnostics\/thermostats)\/(\w+)\/fan_mode$/.exec(path);
    if (match) {
      const thermostat = cloud.thermostat(match[1]);
      if (!thermostat) return json(404, null);
      const setting = thermostat.settings.find((s) => s.type === 'fan_mode');
      if (setting) setting.current_value = body.value;
      const feature = thermostat.features.find((f) => f.name === 'thermostat_fan_mode');
      if (feature) feature.value = body.value;
      cloud.touch();
      return json(200, { success: true, result: { ok: 1 } });
    }
    return json(404, null);
  }

  cloud.request = request;
  return cloud;
}
