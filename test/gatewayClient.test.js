import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  GATEWAY_SUB_CONTAINER_NAME,
  GATEWAY_OCPP_CONTAINER_PORT,
  ensureGatewayRunning,
  fetchGatewayState,
  syncChargerMap,
} from '../src/gatewayClient.js';

test('ensureGatewayRunning: absent -> starts it', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'absent',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys);
  assert.equal(result.started, true);
  assert.equal(gladys.startContainerCalls.length, 1);
});

test('ensureGatewayRunning: stopped -> restarts it', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'stopped',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys);
  assert.equal(result.started, true);
  assert.equal(gladys.startContainerCalls.length, 1);
});

test('ensureGatewayRunning: already running -> does NOT touch the container', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'running',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys);
  assert.equal(result.started, false);
  assert.equal(result.hostPort, 41234);
  assert.equal(gladys.startContainerCalls.length, 0);
});

test('ensureGatewayRunning reports the assigned host port after starting', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'absent',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys);
  assert.equal(result.hostPort, 34000); // fakeGladys assigns this on first start
});

test('fetchGatewayState fetches /api/state and parses JSON', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chargers: { 'CP-1': { identity: 'CP-1' } }, pending: [] }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const state = await fetchGatewayState(`http://127.0.0.1:${port}`);
  assert.deepEqual(state, { chargers: { 'CP-1': { identity: 'CP-1' } }, pending: [] });
});

test('fetchGatewayState throws on a non-OK response', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await assert.rejects(() => fetchGatewayState(`http://127.0.0.1:${port}`), /HTTP 500/);
});

test('syncChargerMap POSTs the map and parses the JSON response', async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, configuredCount: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const result = await syncChargerMap({ 'CP-1': 'wss://cloud-a/ocpp' }, `http://127.0.0.1:${port}`);
  assert.deepEqual(result, { success: true, configuredCount: 1 });
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/api/chargers');
  assert.deepEqual(requests[0].body, { chargers: { 'CP-1': 'wss://cloud-a/ocpp' } });
});

test('syncChargerMap throws on a non-OK response', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(400);
    res.end('bad request');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  await assert.rejects(() => syncChargerMap({}, `http://127.0.0.1:${port}`), /HTTP 400/);
});
