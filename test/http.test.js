// -----------------------------------------------------------------------------
// The HTTP transport on loopback: JSON, redirects not followed, the size cap,
// the timeout, Retry-After.
// -----------------------------------------------------------------------------

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LIMITS } from '../src/constants.js';
import { CODES } from '../src/nexia/errors.js';
import { httpRequest, retryAfterMs } from '../src/nexia/http.js';

let server;
let base;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json', etag: '"abc"' });
        res.end(JSON.stringify({ success: true, echo: body ? JSON.parse(body) : null }));
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://www.mynexia.com/login' });
        res.end('<html>login</html>');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('x'.repeat(LIMITS.MAX_BYTES + 10));
      } else if (req.url === '/slow') {
        setTimeout(() => res.end('{}'), 2_000).unref();
      } else if (req.url === '/busy') {
        res.writeHead(429, { 'retry-after': '120' });
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections?.();
  server.close();
});

test('JSON in and out, the etag', async () => {
  const response = await httpRequest({
    method: 'POST',
    url: `${base}/json`,
    headers: { 'Content-Type': 'application/json' },
    body: { a: 1 },
    timeoutMs: 5_000,
  });
  assert.equal(response.status, 200);
  assert.equal(response.etag, '"abc"');
  assert.deepEqual(response.json, { success: true, echo: { a: 1 } });
});

test('a redirect is not followed', async () => {
  const response = await httpRequest({ url: `${base}/redirect`, timeoutMs: 5_000 });
  assert.equal(response.status, 302);
  assert.equal(response.location, 'https://www.mynexia.com/login');
  assert.equal(response.json, undefined, 'not JSON');
  assert.equal(seen.filter((s) => s.url === '/redirect').length, 1);
});

test('an answer too large is cut', async () => {
  await assert.rejects(
    httpRequest({ url: `${base}/big`, timeoutMs: 5_000 }),
    (err) => err.code === CODES.TOO_LARGE,
  );
});

test('a timeout', async () => {
  await assert.rejects(
    httpRequest({ url: `${base}/slow`, timeoutMs: 100 }),
    (err) => err.code === CODES.TIMEOUT && !err.notSent,
  );
});

test('a 429 and its Retry-After', async () => {
  const response = await httpRequest({ url: `${base}/busy`, timeoutMs: 5_000 });
  assert.equal(response.status, 429);
  assert.equal(response.retryAfterMs, 120_000);
  assert.equal(
    retryAfterMs('Fri, 17 Oct 2026 08:01:00 GMT', Date.parse('2026-10-17T08:00:00Z')),
    60_000,
  );
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});

test('no connection', async () => {
  await assert.rejects(
    httpRequest({ url: 'http://127.0.0.1:1/', timeoutMs: 2_000 }),
    (err) => (err.code === CODES.NETWORK && err.notSent) || err.code === CODES.TIMEOUT,
  );
});
