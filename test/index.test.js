// -----------------------------------------------------------------------------
// Exercises registerHandlers() (index.js) against the SDK's own fake Gladys
// (`@gladysassistant/integration-sdk/testing`), which calls each registered
// handler with the EXACT argument shape the real SDK uses. This is a
// regression test for a real bug: `onAction` invokes its callback as `callback(fields)`, not `callback({ fields })` - the wrong
// destructure crashed on `fields.identity` the moment the action ran for
// real, and nothing here would have caught it before this file existed,
// since index.js's own wiring wasn't unit-tested at all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../index.js';
import { GATEWAY_SUB_CONTAINER_NAME, GATEWAY_OCPP_CONTAINER_PORT } from '../src/gatewayClient.js';

// The gateway sub-container as the supervisor reports it once started.
const RUNNING_GATEWAY = [
  {
    name: GATEWAY_SUB_CONTAINER_NAME,
    status: 'running',
    ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
  },
];

// The discovered-device lists published so far, one entry per publish.
const discoveryBatches = (gladys) =>
  gladys.fake.bodies('POST', '/discovered_device').map((body) => body.devices);

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

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY, ...fakeGladysOptions });
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
  // The SDK's fake runs the registered onAction handler with the exact
  // arguments the real one passes, and resolves with the ack Gladys receives.
  const ack = await gladys.fake.action('add_charger', {
    device: deviceExternalId(gladys, 'CP-1'),
    origin_cloud_url: 'wss://cloud-a/ocpp?sn=',
  });

  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /CP-1.*configured/);
  const configWrites = gladys.fake.bodies('POST', '/config');
  assert.equal(configWrites.length, 1);
  const stored = JSON.parse(gladys.fake.config.chargers_json);
  assert.equal(stored['CP-1'], 'wss://cloud-a/ocpp?sn=');
});

test('add_charger action: rejects a missing device selection', async (t) => {
  const gladys = await setup(t);
  const ack = await gladys.fake.action('add_charger', {
    device: '',
    origin_cloud_url: 'wss://cloud-a/ocpp',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Select a charge point/);
});

test("add_charger action: rejects an external_id that isn't one of this integration's charge points", async (t) => {
  const gladys = await setup(t);
  const ack = await gladys.fake.action('add_charger', {
    device: 'ext:other:thermostat:XYZ',
    origin_cloud_url: 'wss://c/ocpp',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /Not one of this integration's charge points/);
});

test('add_charger action: rejects a non-ws(s) origin cloud URL', async (t) => {
  const gladys = await setup(t);
  const ack = await gladys.fake.action('add_charger', {
    device: deviceExternalId(gladys, 'CP-1'),
    origin_cloud_url: 'http://cloud-a/ocpp',
  });
  assert.equal(ack.success, false);
  assert.match(ack.error, /valid ws:\/\/ or wss:\/\//);
});

test('add_charger action: an empty URL detaches a previously configured charge point', async (t) => {
  const gladys = await setup(t, {
    config: { chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }) },
  });

  const ack = await gladys.fake.action('add_charger', {
    device: deviceExternalId(gladys, 'CP-1'),
    origin_cloud_url: '',
  });

  assert.match(ack.data.message.en, /CP-1.*detached/);
  const stored = JSON.parse(gladys.fake.config.chargers_json);
  assert.deepEqual(stored, {});
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

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  const { refreshDiscovery } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.connect();
  assert.equal(discoveryBatches(gladys).length, 1);
  assert.deepEqual(discoveryBatches(gladys)[0], []);

  // Nothing moved: no second publish, so no needless websocket update.
  await refreshDiscovery();
  assert.equal(discoveryBatches(gladys).length, 1);

  chargers = { 'CP-LATE': { identity: 'CP-LATE', connectors: { 1: { status: 'Available' } } } };
  await refreshDiscovery();
  assert.equal(discoveryBatches(gladys).length, 2);
  assert.deepEqual(
    discoveryBatches(gladys)[1].map((d) => d.external_id),
    ['ext:test-integration:charger-station:CP-LATE'],
  );

  // Still nothing new: stays quiet.
  await refreshDiscovery();
  assert.equal(discoveryBatches(gladys).length, 2);
});

test('discovery refresh: republishes when an already-known charge point reports a new connector', async (t) => {
  let chargers = {
    'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Available' } } },
  };
  const server = startMutableGatewayServer(() => chargers);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  const { refreshDiscovery } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.connect();
  assert.equal(discoveryBatches(gladys).length, 1);

  chargers = {
    'CP-1': {
      identity: 'CP-1',
      connectors: { 1: { status: 'Available' }, 2: { status: 'Available' } },
    },
  };
  await refreshDiscovery();
  assert.equal(discoveryBatches(gladys).length, 2);
  assert.equal(discoveryBatches(gladys)[1][0].features.length, 12);
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

  const byFeature = new Map(gladys.fake.states.map((p) => [p.device_feature_external_id, p.state]));
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':connector-status:1:1'), 1);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':charging-state:1:1'), 0);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':voltage:1:1'), 230);
  assert.equal(byFeature.get(deviceExternalId(gladys, 'CP-1') + ':power:1:1'), 7.2);
});

test('gateway change: the widget is nudged on a status change, not on a meter value', async (t) => {
  const gladys = await setup(t);
  const change = (connector) =>
    gladys.handleGatewayChange({
      identity: 'CP-1',
      charger: { identity: 'CP-1', connectors: { 1: connector } },
    });

  await change({ status: 'Available' });
  assert.deepEqual(gladys.fake.widgetRefreshes, ['charger'], 'first sight of a charge point');

  await change({ status: 'Available', powerActiveImportW: 0, voltageV: 231 });
  assert.equal(gladys.fake.widgetRefreshes.length, 1, 'a meter value alone is not worth a re-pull');

  await change({ status: 'Charging', transactionId: 3 });
  assert.equal(gladys.fake.widgetRefreshes.length, 2);
});

test('gateway change: a new charge point refreshes Discovery, a known one does not', async (t) => {
  let chargers = {};
  const { server } = startFakeEventStreamServer(() => chargers);
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  const { handleGatewayChange } = registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.connect();
  assert.equal(discoveryBatches(gladys).length, 1);

  const connectors = { 1: { status: 'Available' } };
  chargers = { 'CP-1': { identity: 'CP-1', connectors } };
  await handleGatewayChange({ identity: 'CP-1', charger: { identity: 'CP-1', connectors } });
  assert.equal(discoveryBatches(gladys).length, 2, 'a charge point never seen shows up');

  // Same shape: the meter values that follow must not re-publish devices.
  await handleGatewayChange({
    identity: 'CP-1',
    charger: { identity: 'CP-1', connectors: { 1: { status: 'Charging' } } },
  });
  assert.equal(discoveryBatches(gladys).length, 2);

  // A second connector reported later IS a structure change.
  const grown = { 1: { status: 'Charging' }, 2: { status: 'Available' } };
  chargers = { 'CP-1': { identity: 'CP-1', connectors: grown } };
  await handleGatewayChange({ identity: 'CP-1', charger: { identity: 'CP-1', connectors: grown } });
  assert.equal(discoveryBatches(gladys).length, 3);
});

test('gateway change: an event with no identity or no charger is ignored', async (t) => {
  const gladys = await setup(t);
  await gladys.handleGatewayChange({});
  await gladys.handleGatewayChange({ identity: 'CP-1' });
  await gladys.handleGatewayChange({ charger: { connectors: {} } });
  assert.equal(gladys.fake.states.length, 0);
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

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    discoveryRefreshIntervalMs: 0,
  });

  await gladys.connect();
  while (stream.connections.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  stream.emit({
    identity: 'CP-1',
    charger: { identity: 'CP-1', connectors: { 1: { status: 'Charging', voltageV: 400 } } },
  });

  const featureId = deviceExternalId(gladys, 'CP-1') + ':voltage:1:1';
  while (gladys.fake.lastState(featureId) === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gladys.fake.lastState(featureId), 400);

  await gladys.fake.shutdown('SIGTERM');
});

test("connected event: called with no arguments (the real SDK shape), doesn't throw", async (t) => {
  const gladys = await setup(t);
  // connect() runs the registered 'connected' listeners, as the real SDK does.
  await gladys.connect();
  // The OCPP URL is no longer put in the status message: the manifest's
  // how_to section embeds it through the {{gladys_host}}/{{port:ocpp}} placeholders.
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, true);
});

test('reconcileGateway (via "connected"): retries the gateway sync and recovers if it comes up in time', async (t) => {
  const { server, getAttempts } = startFlakyGatewayServer(2); // fails twice, succeeds on the 3rd
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    gatewayRetry: { attempts: 5, delayMs: 1 },
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.connect();

  assert.equal(getAttempts(), 3);
  assert.equal(gladys.fake.connectionStatuses.at(-1).connected, true);
});

test('reconcileGateway (via "connected"): reports disconnected once retries are exhausted', async (t) => {
  const { server, getAttempts } = startFlakyGatewayServer(Infinity); // never recovers
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const gladys = createFakeGladys({ containers: RUNNING_GATEWAY });
  registerHandlers(gladys, {
    gatewayBaseUrl: `http://127.0.0.1:${port}`,
    gatewayRetry: { attempts: 3, delayMs: 1 },
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });

  await gladys.connect();

  assert.equal(getAttempts(), 3);
  const lastStatus = gladys.fake.connectionStatuses.at(-1);
  assert.equal(lastStatus.connected, false);
  assert.match(lastStatus.message.en, /unable to start the gateway/i);
});
