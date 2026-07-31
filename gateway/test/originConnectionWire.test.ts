/**
 * Wire-level proof that query-string identity addressing (originConnection.ts)
 * actually produces the intended URL on the socket - not just structurally
 * (already covered in originConnection.test.ts), but as really sent by
 * `ocpp-rpc`'s RPCClient over a real connection attempt.
 *
 * Test at the lowest possible level: a raw HTTP server that inspects
 * `req.url` (the request as actually sent on the wire) on the `upgrade`
 * event, NOT an RPCServer - RPCServer has its own identity-parsing
 * convention (last path segment) which does not match the query-string
 * addressing mode under test here and would give a misleading result.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RPCClient } from 'ocpp-rpc';
import { buildPrimaryConnectionOptions } from '../src/originConnection.ts';

const CLOUD_PORT = 19532;
const IDENTITY = 'CP12345';
const ORIGIN_URL_ENDING_IN_QUERY = `ws://localhost:${CLOUD_PORT}/ocpp/webSocket?sn=`;

type ClientOptions = ConstructorParameters<typeof RPCClient>[0];

test('query-string identity addressing: the real socket URL carries the identity in the query string', async (t) => {
  const conn = buildPrimaryConnectionOptions(ORIGIN_URL_ENDING_IN_QUERY, IDENTITY);
  assert.equal(conn.endpoint, `ws://localhost:${CLOUD_PORT}/ocpp/webSocket`);
  assert.equal(conn.identity, '.');
  assert.deepEqual(conn.query, { sn: IDENTITY });

  // Raw HTTP server: captures the request exactly as it arrives on the
  // wire, without going through the RPCServer layer (whose identity
  // convention does not match this addressing mode).
  let capturedUrl: string | null = null;
  const httpServer = createServer();
  httpServer.on('upgrade', (req, socket) => {
    capturedUrl = req.url ?? null;
    socket.destroy(); // no need to complete the WS handshake for this test
  });
  await new Promise<void>((resolve) => httpServer.listen(CLOUD_PORT, resolve));
  t.after(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));

  const client = new RPCClient({
    endpoint: conn.endpoint,
    identity: conn.identity,
    query: conn.query,
    protocols: ['ocpp1.6'],
  } as unknown as ClientOptions);

  // The socket is destroyed server-side before the WS handshake completes:
  // connect() necessarily fails (expected, not what's under test) - only
  // req.url matters here.
  client.connect().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  await client.close({ force: true }).catch(() => {});

  assert.equal(capturedUrl, `/ocpp/webSocket/?sn=${IDENTITY}`);
});
