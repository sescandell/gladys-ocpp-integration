import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityAddressingMode, buildPrimaryConnectionOptions } from '../src/originConnection.ts';

test('identityAddressingMode: no query string -> path-segment', () => {
  assert.equal(identityAddressingMode('wss://cloud.example.com/ocpp/webSocket'), 'path-segment');
});

test('identityAddressingMode: any query string -> query-string', () => {
  assert.equal(
    identityAddressingMode('wss://cloud.example.com/ocpp/webSocket?sn='),
    'query-string',
  );
  assert.equal(
    identityAddressingMode('wss://cloud.example.com/ocpp/webSocket?token=abc&sn='),
    'query-string',
  );
});

test('path-segment mode: passes the origin URL and identity through untouched', () => {
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket',
    'CP12345',
  );
  assert.deepEqual(options, {
    endpoint: 'wss://cloud.example.com/ocpp/webSocket',
    identity: 'CP12345',
  });
});

test('query-string mode: fills the single trailing empty parameter with the identity', () => {
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket?sn=',
    'CP12345',
  );
  assert.equal(options.endpoint, 'wss://cloud.example.com/ocpp/webSocket');
  assert.equal(options.identity, '.');
  assert.deepEqual(options.query, { sn: 'CP12345' });
});

test('query-string mode: preserves fixed parameters that come before the empty one', () => {
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket?token=abc&sn=',
    'CP12345',
  );
  assert.deepEqual(options.query, { token: 'abc', sn: 'CP12345' });
});

test('query-string mode: fills the LAST empty parameter when several are present', () => {
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket?a=&b=1&c=',
    'CP12345',
  );
  assert.deepEqual(options.query, { a: '', b: '1', c: 'CP12345' });
});

test('query-string mode: throws a guiding error when no parameter is empty', () => {
  assert.throws(
    () =>
      buildPrimaryConnectionOptions(
        'wss://cloud.example.com/ocpp/webSocket?sn=already-filled',
        'CP12345',
      ),
    /empty parameter/,
  );
});

test('query-string mode: strips a trailing slash on the endpoint to avoid a double slash', () => {
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket/?sn=',
    'CP12345',
  );
  assert.equal(options.endpoint, 'wss://cloud.example.com/ocpp/webSocket');
});

test("structural proof: reconstructing ocpp-rpc's own connUrl formula reproduces the intended wire URL", () => {
  // Mirrors node_modules/ocpp-rpc/lib/client.js, connect():
  //   connUrl = endpoint + '/' + encodeURIComponent(identity);
  //   if (query) connUrl += '?' + new URLSearchParams(query).toString();
  const options = buildPrimaryConnectionOptions(
    'wss://cloud.example.com/ocpp/webSocket?sn=',
    'CP12345',
  );
  let connUrl = options.endpoint + '/' + encodeURIComponent(options.identity);
  if (options.query) {
    connUrl += '?' + new URLSearchParams(options.query).toString();
  }
  const parsed = new URL(connUrl);
  // Known, documented artifact: the "/." path segment collapses, leaving a
  // trailing slash right before the query string that wasn't present in the
  // URL as configured by the user.
  assert.equal(parsed.pathname, '/ocpp/webSocket/');
  assert.equal(parsed.search, '?sn=CP12345');
  assert.equal(parsed.href, 'wss://cloud.example.com/ocpp/webSocket/?sn=CP12345');
});
