// -----------------------------------------------------------------------------
// One HTTPS request to the cloud, with Node's fetch: redirects are NOT
// followed (a 302 is how the cloud says the session expired), the answer is
// read up to LIMITS.MAX_BYTES, and the timeout is our own timer (not
// AbortSignal.timeout, whose unref'd timer behaves differently in tests).
//
//   request({ method, url, headers, body, timeoutMs, onSent })
//     -> { status, etag, location, retryAfterMs, json }
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';
import { CODES, NexiaError } from './errors.js';

/** Retry-After in milliseconds (seconds or an HTTP date), or undefined. */
export function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

async function readBounded(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => {});
    throw new NexiaError(CODES.TOO_LARGE, { status: response.status });
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new NexiaError(CODES.TOO_LARGE, { status: response.status });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function httpRequest({
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs,
  onSent,
  fetchImpl = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    let response;
    try {
      const pending = fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal,
      });
      onSent?.();
      response = await pending;
    } catch {
      // Never the message of the error: it may carry the address with a query.
      if (controller.signal.aborted) throw new NexiaError(CODES.TIMEOUT);
      throw new NexiaError(CODES.NETWORK);
    }
    let text;
    try {
      text = await readBounded(response, LIMITS.MAX_BYTES);
    } catch (err) {
      if (err instanceof NexiaError) throw err;
      if (controller.signal.aborted) throw new NexiaError(CODES.TIMEOUT);
      throw new NexiaError(CODES.NETWORK);
    }
    let json = null;
    if (text.trim() !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // not JSON: the caller decides (a 302 page, an HTML error)
      }
    }
    return {
      status: response.status,
      etag: response.headers.get('etag') ?? undefined,
      location: response.headers.get('location') ?? undefined,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after') ?? undefined),
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}
