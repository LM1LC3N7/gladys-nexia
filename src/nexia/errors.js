// -----------------------------------------------------------------------------
// The errors of the cloud client. A code, an HTTP status when there is one,
// never the body of an answer (it may echo the e-mail address).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  /** The e-mail or the password was refused (sign-in). */
  REFUSED: 'refused',
  /** The session (api key) was refused and no new login is allowed yet. */
  SESSION: 'session',
  /** HTTP 429: every request waits (retryAfterMs). */
  RATE_LIMITED: 'rate_limited',
  /** Any other HTTP status. */
  HTTP: 'http',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  /** The answer is not what the app expects (not JSON, missing fields). */
  BAD_ANSWER: 'bad_answer',
  TOO_LARGE: 'too_large',
  /** A command address that is not on the cloud of the brand: never called. */
  BAD_URL: 'bad_url',
  /** Not enough time left before Gladys gives up: nothing was sent. */
  DEADLINE: 'deadline',
});

export class NexiaError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {{ status?: number, retryAfterMs?: number, retryAt?: number, notSent?: boolean }} [details]
   */
  constructor(code, { status, retryAfterMs, retryAt, notSent = false } = {}) {
    super(status ? `${code} (HTTP ${status})` : code);
    this.name = 'NexiaError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryAt = retryAt;
    this.notSent = notSent;
  }
}

export const isRefused = (err) => err instanceof NexiaError && err.code === CODES.REFUSED;
export const isRateLimited = (err) => err instanceof NexiaError && err.code === CODES.RATE_LIMITED;
