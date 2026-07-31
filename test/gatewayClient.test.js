import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  GATEWAY_SUB_CONTAINER_NAME,
  GATEWAY_OCPP_CONTAINER_PORT,
  pickSupervisedCharger,
  ensureGatewayRunning,
  fetchGatewayState,
} from '../src/gatewayClient.js';

test('pickSupervisedCharger returns null when nothing is known yet', () => {
  assert.equal(pickSupervisedCharger({}), null);
  assert.equal(pickSupervisedCharger(undefined), null);
});

test('pickSupervisedCharger returns the single entry when there is one', () => {
  const charger = { identity: 'CP-1', lastSeenAt: '2026-08-01T10:00:00.000Z' };
  assert.equal(pickSupervisedCharger({ 'CP-1': charger }), charger);
});

test('pickSupervisedCharger picks the most recently seen entry when there are several', () => {
  const older = { identity: 'CP-1', lastSeenAt: '2026-08-01T09:00:00.000Z' };
  const newer = { identity: 'CP-2', lastSeenAt: '2026-08-01T10:00:00.000Z' };
  assert.equal(pickSupervisedCharger({ 'CP-1': older, 'CP-2': newer }), newer);
});

const config = { origin_cloud_url: 'wss://cloud.example.com/ocpp' };

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
  const result = await ensureGatewayRunning(gladys, config);
  assert.equal(result.started, true);
  assert.equal(gladys.startContainerCalls.length, 1);
  assert.deepEqual(gladys.startContainerCalls[0].env, {
    ORIGIN_CLOUD_URL: config.origin_cloud_url,
  });
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
  const result = await ensureGatewayRunning(gladys, config);
  assert.equal(result.started, true);
  assert.equal(gladys.startContainerCalls.length, 1);
});

test('ensureGatewayRunning: already running, URL unchanged -> does NOT touch the container', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'running',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys, config, false);
  assert.equal(result.started, false);
  assert.equal(result.hostPort, 41234);
  assert.equal(gladys.startContainerCalls.length, 0);
});

test('ensureGatewayRunning: already running, forceRestart -> restarts it', async () => {
  const gladys = createFakeGladys({
    containers: [
      {
        name: GATEWAY_SUB_CONTAINER_NAME,
        status: 'running',
        ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 41234 }],
      },
    ],
  });
  const result = await ensureGatewayRunning(gladys, config, true);
  assert.equal(result.started, true);
  assert.equal(gladys.startContainerCalls.length, 1);
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
  const result = await ensureGatewayRunning(gladys, config);
  assert.equal(result.hostPort, 34000); // fakeGladys assigns this on first start
});

test('fetchGatewayState fetches /api/state and parses JSON', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'CP-1': { identity: 'CP-1' } }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const state = await fetchGatewayState(`http://127.0.0.1:${port}`);
  assert.deepEqual(state, { 'CP-1': { identity: 'CP-1' } });
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
