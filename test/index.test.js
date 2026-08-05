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
      res.end(JSON.stringify({ chargers: {} }));
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

// A gateway that fails its first `failCount` POST /api/chargers requests
// (503, simulating "the sub-container is running per Docker but its Node
// process hasn't bound its HTTP server yet" - see index.js's
// withGatewayRetries doc comment), then succeeds. `failCount: Infinity`
// never recovers.
function startFlakyGatewayServer(failCount) {
  let attempts = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chargers: {} }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chargers') {
      attempts += 1;
      if (attempts <= failCount) {
        res.writeHead(503);
        res.end();
        return;
      }
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
  return { server, getAttempts: () => attempts };
}

// A gateway whose observed state the test can change between calls, to
// simulate a charge point connecting after the last publish.
function startMutableGatewayServer(getChargers) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chargers: getChargers() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chargers') {
      req.resume();
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

async function setup(t, fakeGladysOptions = {}, registerOptions = {}) {
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
    ...fakeGladysOptions,
  });
  const handlers = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
    ...registerOptions,
  });
  return Object.assign(gladys, handlers);
}

// What Gladys hands back for a `select` with `source: "devices"`: the
// device's external_id, not the OCPP identity (see index.js's add_charger
// doc comment). Built through the fake's own externalIds() so this stays in
// step with however ids are shaped.
function deviceExternalId(gladys, identity) {
  return gladys.externalIds('charger-station', identity).device;
}

test('add_charger action: called with fields directly (the real SDK shape), not { fields }', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  assert.ok(typeof addCharger === 'function', 'add_charger must be registered');

  // The exact shape gladys.onAction's callback receives in production -
  // NOT wrapped in { fields: ... }.
  const message = await addCharger({
    device: deviceExternalId(gladys, 'CP-1'),
    origin_cloud_url: 'wss://cloud-a/ocpp?sn=',
  });

  assert.match(message.en, /CP-1.*configured/);
  assert.equal(gladys.setConfigCalls.length, 1);
  const stored = JSON.parse(gladys.setConfigCalls[0].chargers_json);
  assert.equal(stored['CP-1'], 'wss://cloud-a/ocpp?sn=');
});

test('add_charger action: rejects a missing device selection', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  await assert.rejects(
    () => addCharger({ device: '', origin_cloud_url: 'wss://cloud-a/ocpp' }),
    /Select a charge point/,
  );
});

test("add_charger action: rejects an external_id that isn't one of this integration's charge points", async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  await assert.rejects(
    () => addCharger({ device: 'ext:other:thermostat:XYZ', origin_cloud_url: 'wss://c/ocpp' }),
    /Not one of this integration's charge points/,
  );
});

test('add_charger action: rejects a non-ws(s) origin cloud URL', async (t) => {
  const gladys = await setup(t);
  const addCharger = gladys.handlers.actions['add_charger'];
  await assert.rejects(
    () =>
      addCharger({
        device: deviceExternalId(gladys, 'CP-1'),
        origin_cloud_url: 'http://cloud-a/ocpp',
      }),
    /valid ws:\/\/ or wss:\/\//,
  );
});

test('add_charger action: an empty URL detaches a previously configured charge point', async (t) => {
  const gladys = await setup(t, {
    config: { chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }) },
  });
  const addCharger = gladys.handlers.actions['add_charger'];

  const message = await addCharger({
    device: deviceExternalId(gladys, 'CP-1'),
    origin_cloud_url: '',
  });

  assert.match(message.en, /CP-1.*detached/);
  const stored = JSON.parse(gladys.setConfigCalls.at(-1).chargers_json);
  assert.deepEqual(stored, {});
});

test('reset_all action: rejects without the exact "RESET" confirmation', async (t) => {
  const gladys = await setup(t, {
    config: { chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }) },
  });
  const resetAll = gladys.handlers.actions['reset_all'];

  await assert.rejects(() => resetAll({ confirm: '' }), /Type RESET/);
  await assert.rejects(() => resetAll({ confirm: 'reset' }), /Type RESET/);
  assert.equal(gladys.setConfigCalls.length, 0);
  assert.equal(gladys.restartContainerCalls.length, 0);
});

test('reset_all action: clears every configured charge point and restarts the gateway sub-container', async (t) => {
  const gladys = await setup(t, {
    config: { chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }) },
  });
  const resetAll = gladys.handlers.actions['reset_all'];

  const message = await resetAll({ confirm: 'RESET' });

  const stored = JSON.parse(gladys.setConfigCalls.at(-1).chargers_json);
  assert.deepEqual(stored, {});
  assert.equal(gladys.restartContainerCalls.length, 1);
  assert.equal(gladys.restartContainerCalls[0].name, GATEWAY_SUB_CONTAINER_NAME);
  assert.match(message.en, /cleared/i);
  assert.match(message.en, /not.*removed/i);
});

test('discovery refresh: republishes once a charge point shows up in the gateway, and only then', async (t) => {
  // The gateway can only be polled (it never pushes), and a charge point
  // connects on its own schedule - typically after the reconnection
  // republish has already run, which used to leave it invisible until the
  // user happened to hit Rescan.
  let chargers = {};
  const server = startMutableGatewayServer(() => chargers);
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
  });
  const { refreshDiscovery } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.handlers.events['connected']();
  assert.equal(gladys.discoveredDeviceBatches.length, 1);
  assert.deepEqual(gladys.discoveredDeviceBatches[0], []);

  // Nothing moved: no second publish, so no needless websocket update.
  await refreshDiscovery();
  assert.equal(gladys.discoveredDeviceBatches.length, 1);

  chargers = { 'CP-LATE': { identity: 'CP-LATE', connectors: { 1: { status: 'Available' } } } };
  await refreshDiscovery();
  assert.equal(gladys.discoveredDeviceBatches.length, 2);
  assert.deepEqual(
    gladys.discoveredDeviceBatches[1].map((d) => d.external_id),
    ['charger-station:CP-LATE'],
  );

  // Still nothing new: stays quiet.
  await refreshDiscovery();
  assert.equal(gladys.discoveredDeviceBatches.length, 2);
});

test('discovery refresh: republishes when an already-known charge point reports a new connector', async (t) => {
  let chargers = {
    'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Available' } } },
  };
  const server = startMutableGatewayServer(() => chargers);
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
  });
  const { refreshDiscovery } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.handlers.events['connected']();
  assert.equal(gladys.discoveredDeviceBatches.length, 1);

  chargers = {
    'CP-1': {
      identity: 'CP-1',
      connectors: { 1: { status: 'Available' }, 2: { status: 'Available' } },
    },
  };
  await refreshDiscovery();
  assert.equal(gladys.discoveredDeviceBatches.length, 2);
  assert.equal(gladys.discoveredDeviceBatches[1][0].features.length, 12);
});

// The gateway's SSE change stream (gateway/src/changeFeed.ts), reduced to what
// the client has to cope with: a comment frame, then data frames.
function startFakeEventStreamServer(getChargers) {
  const connections = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ chargers: getChargers() }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(':subscribed\n\n');
      connections.push(res);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/chargers') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, configuredCount: 0 }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return {
    server,
    connections,
    emit(change) {
      for (const res of connections) res.write(`data: ${JSON.stringify(change)}\n\n`);
    },
  };
}

test('gateway change: publishes the charge point states without calling back to the gateway', async (t) => {
  const gladys = await setup(t);

  await gladys.handleGatewayChange({
    identity: 'CP-1',
    charger: {
      identity: 'CP-1',
      connectors: { 1: { status: 'Charging', voltageV: 230, powerActiveImportW: 7200 } },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const byFeature = new Map(gladys.published.map((p) => [p.featureExternalId, p.state]));
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':connector-status:1'), 1);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':charging-state:1'), 0);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':voltage:1'), 230);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':power:1'), 7.2);
});

test('gateway change: a new charge point refreshes Discovery, a known one does not', async (t) => {
  let chargers = {};
  const { server } = startFakeEventStreamServer(() => chargers);
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
  });
  const { handleGatewayChange } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.handlers.events['connected']();
  assert.equal(gladys.discoveredDeviceBatches.length, 1);

  const connectors = { 1: { status: 'Available' } };
  chargers = { 'CP-1': { identity: 'CP-1', connectors } };
  await handleGatewayChange({ identity: 'CP-1', charger: { identity: 'CP-1', connectors } });
  assert.equal(gladys.discoveredDeviceBatches.length, 2, 'a charge point never seen shows up');

  // Same shape: the meter values that follow must not re-publish devices.
  await handleGatewayChange({
    identity: 'CP-1',
    charger: { identity: 'CP-1', connectors: { 1: { status: 'Charging' } } },
  });
  assert.equal(gladys.discoveredDeviceBatches.length, 2);

  // A second connector reported later IS a structure change.
  const grown = { 1: { status: 'Charging' }, 2: { status: 'Available' } };
  chargers = { 'CP-1': { identity: 'CP-1', connectors: grown } };
  await handleGatewayChange({ identity: 'CP-1', charger: { identity: 'CP-1', connectors: grown } });
  assert.equal(gladys.discoveredDeviceBatches.length, 3);
});

test('gateway change: an event with no identity or no charger is ignored', async (t) => {
  const gladys = await setup(t);
  await gladys.handleGatewayChange({});
  await gladys.handleGatewayChange({ identity: 'CP-1' });
  await gladys.handleGatewayChange({ charger: { connectors: {} } });
  assert.equal(gladys.published.length, 0);
});

test('event stream: states reach Gladys from a live SSE connection', async (t) => {
  const chargers = {};
  const stream = startFakeEventStreamServer(() => chargers);
  await new Promise((resolve) => stream.server.listen(0, resolve));
  t.after(() => {
    for (const res of stream.connections) res.end();
    stream.server.close();
  });
  const { port } = stream.server.address();

  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'running',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
      },
    ],
  });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
  });

  await gladys.handlers.events['connected']();
  while (stream.connections.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  stream.emit({
    identity: 'CP-1',
    charger: { identity: 'CP-1', connectors: { 1: { status: 'Charging', voltageV: 400 } } },
  });

  const featureId = deviceExternalId(gladys, 'CP-1') + ':voltage:1';
  while (!gladys.published.some((p) => p.featureExternalId === featureId)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gladys.published.find((p) => p.featureExternalId === featureId).state, 400);

  gladys.handlers.shutdown('SIGTERM');
});

test("connected event: called with no arguments (the real SDK shape), doesn't throw", async (t) => {
  const gladys = await setup(t);
  const connectedHandler = gladys.handlers.events['connected'];
  assert.ok(typeof connectedHandler === 'function', 'a "connected" listener must be registered');
  await connectedHandler();
  assert.ok(gladys.connectionStatuses.length > 0);
  // The "pending" concept is gone - auto-detected charge points show up
  // directly in Discovery instead (see src/devices/charger.js).
  assert.doesNotMatch(gladys.connectionStatuses.at(-1).message.en, /awaiting configuration/i);
});

test('reconcileGateway (via "connected"): connection status shows the ready-to-use OCPP URL, not a generic sentence', async (t) => {
  const gladys = await setup(t);

  await gladys.handlers.events['connected']();

  const status = gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, true);
  // Host port 41234 comes from the fake container fixture in setup().
  assert.match(status.message.en, /ws:\/\/.*:41234\//);
  assert.match(status.message.fr, /ws:\/\/.*:41234\//);
  assert.doesNotMatch(status.message.en, /Relay running on port/);
});

test('reconcileGateway (via "connected"): retries the gateway sync and recovers if it comes up in time', async (t) => {
  const { server, getAttempts } = startFlakyGatewayServer(2); // fails twice, succeeds on the 3rd
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
  });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    gatewayRetry: { attempts: 5, delayMs: 1 },
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.handlers.events['connected']();

  assert.equal(getAttempts(), 3);
  assert.equal(gladys.connectionStatuses.at(-1).connected, true);
});

test('reconcileGateway (via "connected"): reports disconnected once retries are exhausted', async (t) => {
  const { server, getAttempts } = startFlakyGatewayServer(Infinity); // never recovers
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
  });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    gatewayRetry: { attempts: 3, delayMs: 1 },
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.handlers.events['connected']();

  assert.equal(getAttempts(), 3);
  const lastStatus = gladys.connectionStatuses.at(-1);
  assert.equal(lastStatus.connected, false);
  assert.match(lastStatus.message.en, /unable to start the gateway/i);
});
