// -----------------------------------------------------------------------------
// The cloud of Trane / American Standard (the "mobile" API the apps use),
// ported from the nexia library (bdraco/nexia, home.py, Apache-2.0).
//
//   login()   POST /mobile/accounts/sign_in  -> mobile_id + api_key
//             POST /mobile/session            -> the house id (first house)
//   house()   GET  /mobile/houses/<id>        (If-None-Match: 304 = unchanged)
//   send()    POST or PUT on the address the thermostat gives for a setting
//
// The api key and the mobile id are kept in memory and sent with every
// request (X-ApiKey, X-MobileId): no new login at each reading. A refused
// session (302 to the login page, 401, 403) gets ONE new login, at most one
// every 5 minutes; a session refused minutes after its login doubles that
// spacing (up to 6 h). A refused e-mail or password is a REFUSED error: the
// client never logs in again by itself (the app decides).
// -----------------------------------------------------------------------------

import { APP_VERSION, BRANDS, DEVICE_NAME, ID_PATTERN, INTERVALS, TIMEOUTS } from '../constants.js';
import { CODES, NexiaError } from './errors.js';
import { httpRequest } from './http.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SESSION_REFUSED = new Set([301, 302, 303, 307, 308, 401, 403]);

export class NexiaClient {
  /**
   * @param {object} options
   * @param {'nexia' | 'trane' | 'asair'} options.brand
   * @param {string} options.email
   * @param {string} options.password
   * @param {string} options.deviceUuid stable per installation (the library keeps it in a file)
   * @param {Function} [options.request] the HTTP transport (tests inject a fake cloud)
   * @param {() => number} [options.now]
   */
  constructor({ brand, email, password, deviceUuid, request = httpRequest, now = Date.now }) {
    this.brand = BRANDS[brand] ? brand : 'nexia';
    this.root = BRANDS[this.brand].root;
    this.origin = new URL(this.root).origin;
    this.mobile = `${this.root}/mobile`;
    this.email = email;
    this.password = password;
    this.deviceUuid = deviceUuid;
    this.request = request;
    this.now = now;
    this.mobileId = null;
    this.apiKey = null;
    this.houseId = null;
    this.houseName = null;
    this.etag = undefined;
    this.cache = null;
    this.loginAt = -Infinity;
    this.nextLoginAt = 0;
    this.loginSpacing = INTERVALS.LOGIN_SPACING_MS;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  get hasSession() {
    return Boolean(this.apiKey && this.mobileId);
  }

  headers(body) {
    const headers = {
      Accept: 'application/json',
      'X-AppVersion': APP_VERSION,
      'X-AssociatedBrand': this.brand,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.mobileId) headers['X-MobileId'] = String(this.mobileId);
    if (this.apiKey) headers['X-ApiKey'] = String(this.apiKey);
    return headers;
  }

  /** The time left before `deadline` for one request (a NexiaError when none is left). */
  timeout(deadline) {
    if (deadline === undefined) return TIMEOUTS.REQUEST;
    const left = deadline - this.now();
    if (left <= 0) throw new NexiaError(CODES.DEADLINE, { notSent: true });
    return Math.min(TIMEOUTS.REQUEST, left);
  }

  /** One request; HTTP 429 and 5xx become errors here, the rest is the caller's. */
  async call({ method = 'GET', url, body, extraHeaders = {}, deadline, onSent }) {
    const response = await this.request({
      method,
      url,
      headers: { ...this.headers(body), ...extraHeaders },
      body,
      timeoutMs: this.timeout(deadline),
      onSent,
    });
    if (response.status === 429) {
      throw new NexiaError(CODES.RATE_LIMITED, {
        status: 429,
        retryAfterMs: response.retryAfterMs,
      });
    }
    if (response.status >= 500) throw new NexiaError(CODES.HTTP, { status: response.status });
    return response;
  }

  /** Forget the session (a new login comes with the next request, within the spacing). */
  invalidate() {
    this.mobileId = null;
    this.apiKey = null;
  }

  /**
   * Sign in, then find the house. A login waits for the spacing (SESSION
   * error with retryAt meanwhile): never a login at each reading.
   */
  async login({ deadline } = {}) {
    const now = this.now();
    if (now < this.nextLoginAt) {
      throw new NexiaError(CODES.SESSION, { retryAt: this.nextLoginAt, notSent: true });
    }
    this.loginAt = now;
    this.nextLoginAt = now + this.loginSpacing;
    this.invalidate();
    const response = await this.call({
      method: 'POST',
      url: `${this.mobile}/accounts/sign_in`,
      body: {
        login: this.email,
        password: this.password,
        children: [],
        childSchemas: [],
        commitModel: null,
        nextHref: null,
        device_uuid: this.deviceUuid,
        device_name: DEVICE_NAME,
        app_version: APP_VERSION,
        is_commercial: false,
      },
      deadline,
    });
    // 401 / 403, a redirect (to the login page or to "forgotten credentials"),
    // or `success: false`: the e-mail or the password is refused.
    if (SESSION_REFUSED.has(response.status)) {
      throw new NexiaError(CODES.REFUSED, { status: response.status });
    }
    if (response.status !== 200) throw new NexiaError(CODES.HTTP, { status: response.status });
    if (!isObject(response.json)) throw new NexiaError(CODES.BAD_ANSWER, { status: 200 });
    if (response.json.success !== true) throw new NexiaError(CODES.REFUSED, { status: 200 });
    const result = response.json.result;
    const mobileId = result?.mobile_id;
    const apiKey = result?.api_key;
    if (
      !(typeof mobileId === 'number' || (typeof mobileId === 'string' && mobileId !== '')) ||
      typeof apiKey !== 'string' ||
      apiKey === ''
    ) {
      throw new NexiaError(CODES.BAD_ANSWER, { status: 200 });
    }
    this.mobileId = mobileId;
    this.apiKey = apiKey;
    if (!this.houseId) await this.findHouse({ deadline });
  }

  /** The first house of the account (the library does the same). */
  async findHouse({ deadline } = {}) {
    const response = await this.call({
      method: 'POST',
      url: `${this.mobile}/session`,
      body: { app_version: APP_VERSION, device_uuid: this.deviceUuid },
      deadline,
    });
    if (SESSION_REFUSED.has(response.status)) {
      this.invalidate();
      throw new NexiaError(CODES.SESSION, { status: response.status, retryAt: this.nextLoginAt });
    }
    if (response.status !== 200) throw new NexiaError(CODES.HTTP, { status: response.status });
    const children = response.json?.result?._links?.child;
    const data = Array.isArray(children)
      ? children.find((c) => isObject(c?.data) && c.data.id !== undefined)?.data
      : undefined;
    const id = data === undefined ? '' : String(data.id);
    if (!ID_PATTERN.test(id)) throw new NexiaError(CODES.BAD_ANSWER, { status: 200 });
    this.houseId = id;
    this.houseName = typeof data.name === 'string' ? data.name.slice(0, 100) : null;
  }

  /**
   * The house: { json, changed }. `changed` is false when the cloud answers
   * 304 (nothing new since the last reading, which is then current).
   */
  async house({ deadline } = {}) {
    if (!this.hasSession) await this.login({ deadline });
    let response = await this.getHouse({ deadline, conditional: true });
    if (SESSION_REFUSED.has(response.status)) {
      if (this.now() - this.loginAt < INTERVALS.LOGIN_SPACING_MS) this.freshRefused(response);
      this.invalidate();
      await this.login({ deadline });
      response = await this.getHouse({ deadline, conditional: true });
      if (SESSION_REFUSED.has(response.status)) this.freshRefused(response);
    }
    if (response.status === 304) {
      if (this.cache) return { json: this.cache, changed: false };
      response = await this.getHouse({ deadline, conditional: false });
    }
    if (response.status !== 200) throw new NexiaError(CODES.HTTP, { status: response.status });
    const json = response.json;
    if (!isObject(json?.result) || !Array.isArray(json.result._links?.child)) {
      throw new NexiaError(CODES.BAD_ANSWER, { status: 200 });
    }
    this.cache = json;
    this.etag = typeof response.etag === 'string' ? response.etag : undefined;
    // A session that works: the spacing of the logins is back to its minimum.
    this.loginSpacing = INTERVALS.LOGIN_SPACING_MS;
    if (typeof json.result.name === 'string') this.houseName = json.result.name.slice(0, 100);
    return { json, changed: true };
  }

  /**
   * A session refused minutes after its login: a new login would not help
   * now. The spacing of the logins doubles (up to 6 h); always throws.
   */
  freshRefused(response) {
    this.invalidate();
    this.loginSpacing = Math.min(this.loginSpacing * 2, INTERVALS.LOGIN_SPACING_MAX_MS);
    this.nextLoginAt = this.loginAt + this.loginSpacing;
    throw new NexiaError(CODES.SESSION, { status: response.status, retryAt: this.nextLoginAt });
  }

  getHouse({ deadline, conditional }) {
    const extraHeaders =
      conditional && this.etag && this.cache ? { 'If-None-Match': this.etag } : {};
    return this.call({
      url: `${this.mobile}/houses/${encodeURIComponent(this.houseId)}`,
      extraHeaders,
      deadline,
    });
  }

  /**
   * The address of a setting: the `href` the thermostat gives, kept only on
   * the cloud of the brand (the api key never goes anywhere else), else the
   * library's fallback path under /mobile.
   */
  resolve(action, fallbackPath) {
    if (isObject(action) && typeof action.href === 'string') {
      try {
        const url = new URL(action.href);
        const method = String(action.method ?? 'POST').toUpperCase();
        if (url.origin === this.origin && url.pathname.startsWith('/mobile/') && !url.username) {
          if (method === 'POST' || method === 'PUT') return { url: url.href, method };
        }
      } catch {
        // not an address: the fallback below
      }
    }
    if (!fallbackPath) throw new NexiaError(CODES.BAD_URL, { notSent: true });
    return { url: `${this.mobile}/${fallbackPath}`, method: 'POST' };
  }

  /**
   * Send one setting. Resolves the `result` object of the answer (the new
   * zone or thermostat when the cloud returns it, else null). A refused
   * session is an error (nothing applied): the next reading logs in again.
   */
  async send({ url, method, payload, deadline, onSent }) {
    if (!this.hasSession) throw new NexiaError(CODES.SESSION, { notSent: true });
    const target = new URL(url);
    if (target.origin !== this.origin) throw new NexiaError(CODES.BAD_URL, { notSent: true });
    const response = await this.call({ method, url: target.href, body: payload, deadline, onSent });
    if (SESSION_REFUSED.has(response.status)) {
      this.invalidate();
      throw new NexiaError(CODES.SESSION, { status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new NexiaError(CODES.HTTP, { status: response.status });
    }
    const result = response.json?.result;
    return isObject(result) ? result : null;
  }
}
