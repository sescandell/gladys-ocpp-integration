// -----------------------------------------------------------------------------
// Exercises registerHandlers() (index.js) against a fake SDK object, calling
// each captured handler with the EXACT argument shape the real SDK uses
// (verified against integration-sdk's index.d.ts - see fakeGladys.js's doc
// comment). This is a regression test for a real bug: `onAction` invokes its
// callback as `callback(fields)`, not `callback({ fields })` - the wrong
// destructure crashed on `fields.identity` the moment the action ran for
// real, and nothing here would have caught it before this file existed,
// since index.js's own wiring wasn't unit-tested at all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from './helpers/fakeGladys.js';
import { registerHandlers } from '../index.js';
import { GATEWAY_SUB_CONTAINER_NAME, GATEWAY_OCPP_CONTAINER_PORT } from '../src/gatewayClient.js';

// A fast, local stand-in for the gateway sub-container's internal HTTP API -
// hitting the real one (fixed DNS alias "gateway") from a dev/test machine
// takes several real seconds to fail (DNS), see index.js's gatewayBaseUrl
// option doc comment.
function startFakeGatewayServer() {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chargers: {}, pending: [] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chargers') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, configuredCount: 0 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function setup(t, options = {}) {
  const server = startFakeGatewayServer();
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'running',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
      },
    ],
    ...options,
  });
  registerHandlers(gladys, { gatewayBaseUrl: `http://127.0.0.1:${port}` });
  return gladys;
}

test('add_charger action: called with fields directly (the real SDK shape), not { fields }', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  assert.ok(typeof addCharger === 'function', 'add_charger must be registered');

  // The exact shape gladys.onAction's callback receives in production -
  // NOT wrapped in { fields: ... }.
  const message = await addCharger({
    identity: 'CP-1',
    origin_cloud_url: 'wss://cloud-a/ocpp?sn=',
  });

  assert.match(message.en, /CP-1.*configured/);
  assert.equal(gladys.setConfigCalls.length, 1);
  const stored = JSON.parse(gladys.setConfigCalls[0].chargers_json);
  assert.equal(stored['CP-1'], 'wss://cloud-a/ocpp?sn=');
});

test('add_charger action: rejects a missing identity', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  await assert.rejects(
    () => addCharger({ identity: '', origin_cloud_url: 'wss://cloud-a/ocpp' }),
    /identity is required/,
  );
});

test('add_charger action: rejects a non-ws(s) origin cloud URL', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  await assert.rejects(
    () => addCharger({ identity: 'CP-1', origin_cloud_url: 'http://cloud-a/ocpp' }),
    /valid ws:\/\/ or wss:\/\//,
  );
});

test('add_charger action: an empty URL removes a previously configured charge point', async (t) => {
  const gladys = await setup(t, {
    config: { chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }) },
  });
  const addCharger = gladys.handlers.actions['add_charger'];

  const message = await addCharger({ identity: 'CP-1', origin_cloud_url: '' });

  assert.match(message.en, /CP-1.*removed/);
  const stored = JSON.parse(gladys.setConfigCalls.at(-1).chargers_json);
  assert.deepEqual(stored, {});
});

test("connected event: called with no arguments (the real SDK shape), doesn't throw", async (t) => {
  const gladys = await setup(t);
  const connectedHandler = gladys.handlers.events['connected'];
  assert.ok(typeof connectedHandler === 'function', 'a "connected" listener must be registered');
  await connectedHandler();
  assert.ok(gladys.connectionStatuses.length > 0);
});
