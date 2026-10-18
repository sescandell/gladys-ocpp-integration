// The simulator against a minimal in-process CSMS (ocpp-rpc server) that
// records what it receives - no gateway needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPCServer } from 'ocpp-rpc';
import { SimulatedChargePoint } from '../src/chargePoint.js';
import { createSimulator } from '../src/server.js';

async function startCsms() {
  const server = new RPCServer({ protocols: ['ocpp1.6'] });
  const calls = [];
  const clients = [];
  let nextTransactionId = 100;
  server.on('client', (client) => {
    clients.push(client);
    client.handle(({ method, params }) => {
      calls.push({ identity: client.identity, method, params });
      switch (method) {
        case 'BootNotification':
          return { status: 'Accepted', interval: 300, currentTime: new Date().toISOString() };
        case 'Heartbeat':
          return { currentTime: new Date().toISOString() };
        case 'Authorize':
          return { idTagInfo: { status: 'Accepted' } };
        case 'StartTransaction':
          return { transactionId: nextTransactionId++, idTagInfo: { status: 'Accepted' } };
        case 'StopTransaction':
          return { idTagInfo: { status: 'Accepted' } };
        default:
          return {};
      }
    });
  });
  const httpServer = await server.listen(0);
  const { port } = httpServer.address();
  return {
    calls,
    clients,
    url: `ws://127.0.0.1:${port}/`,
    close: () => server.close({ force: true }),
  };
}

const methods = (calls) => calls.map((c) => c.method);

function chargePoint(url, clock) {
  return new SimulatedChargePoint(
    { url, identity: 'SIM-TEST', speed: 3600, meterIntervalSec: 3600, initialMeterWh: 1000 },
    { random: () => 0.5, now: () => clock.t },
  );
}

test('connecting introduces the charge point: Boot, then a StatusNotification per connector', async (t) => {
  const csms = await startCsms();
  const cp = chargePoint(csms.url, { t: Date.now() });
  t.after(async () => {
    await cp.disconnect();
    await csms.close();
  });

  await cp.connect();
  while (csms.calls.filter((c) => c.method === 'StatusNotification').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.deepEqual(methods(csms.calls).slice(0, 3), [
    'BootNotification',
    'StatusNotification',
    'StatusNotification',
  ]);
  assert.equal(csms.calls[0].identity, 'SIM-TEST');
  assert.equal(csms.calls[0].params.chargePointVendor, 'Simulator');
  assert.deepEqual(
    csms.calls.filter((c) => c.method === 'StatusNotification').map((c) => c.params.connectorId),
    [0, 1],
  );
});

test('a full session: Authorize, StartTransaction, MeterValues with the energy, StopTransaction', async (t) => {
  const csms = await startCsms();
  const clock = { t: Date.parse('2026-10-18T10:00:00Z') };
  const cp = chargePoint(csms.url, clock);
  t.after(async () => {
    await cp.disconnect();
    await csms.close();
  });
  await cp.connect();
  while (!csms.calls.some((c) => c.method === 'StatusNotification' && c.params.connectorId === 1)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  csms.calls.length = 0;

  await cp.startCharge(1, { powerW: 7000 });
  clock.t += 10_000; // 10 s of real time at speed x3600 = 10 h
  await cp.stopCharge(1);

  const start = csms.calls.find((c) => c.method === 'StartTransaction');
  assert.equal(start.params.meterStart, 1000);
  const stop = csms.calls.find((c) => c.method === 'StopTransaction');
  assert.equal(stop.params.transactionId, 100);
  // 7000 W * 10 h = 70 kWh, on top of the initial register.
  assert.equal(stop.params.meterStop, 1000 + 70_000);

  const statuses = csms.calls
    .filter((c) => c.method === 'StatusNotification')
    .map((c) => c.params.status);
  assert.deepEqual(statuses, ['Preparing', 'Charging', 'Finishing']);

  const meter = csms.calls.filter((c) => c.method === 'MeterValues').at(-1);
  const measurands = Object.fromEntries(
    meter.params.meterValue[0].sampledValue.map((s) => [s.measurand, s.value]),
  );
  assert.equal(measurands['Energy.Active.Import.Register'], String(71_000));
  assert.ok('Power.Active.Import' in measurands && 'Voltage' in measurands);
});

test('pausing and faulting report the matching status and error code', async (t) => {
  const csms = await startCsms();
  const cp = chargePoint(csms.url, { t: Date.now() });
  t.after(async () => {
    await cp.disconnect();
    await csms.close();
  });
  await cp.connect();
  while (!csms.calls.some((c) => c.method === 'StatusNotification' && c.params.connectorId === 1)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  csms.calls.length = 0;

  await cp.pause(1, 'EVSE');
  await cp.fault(1, 'GroundFailure');
  await cp.clearFault(1);

  assert.deepEqual(
    csms.calls.map((c) => [c.params.status, c.params.errorCode]),
    [
      ['SuspendedEVSE', 'NoError'],
      ['Faulted', 'GroundFailure'],
      ['Available', 'NoError'],
    ],
  );
});

test('refuses a URL that is not ws:// or wss://', async () => {
  const cp = new SimulatedChargePoint({ url: 'http://nope' });
  await assert.rejects(() => cp.connect(), /ws:\/\/ or wss:\/\//);
});

test('the web API reports the state, saves nothing without a config file, and rejects unknown actions', async (t) => {
  const simulator = await createSimulator({ configFile: null });
  await new Promise((resolve) => simulator.server.listen(0, '127.0.0.1', resolve));
  t.after(() => simulator.close());
  const base = `http://127.0.0.1:${simulator.server.address().port}`;

  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.connection, 'disconnected');
  assert.equal(state.connectors.length, 1);
  assert.ok(state.scenarios.length > 0);

  const updated = await (
    await fetch(`${base}/api/config`, {
      method: 'PUT',
      body: JSON.stringify({ url: 'ws://192.168.1.50:34001/', connectors: 2, nonsense: 1 }),
    })
  ).json();
  assert.equal(updated.config.url, 'ws://192.168.1.50:34001/');
  assert.equal(updated.connectors.length, 2);
  assert.equal(updated.config.nonsense, undefined);

  const unknown = await fetch(`${base}/api/connectors/1/explode`, { method: 'POST' });
  assert.equal(unknown.status, 404);

  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /Simulateur de borne OCPP/);
});

test('an Autel charge point obeys the permanent lock DataTransfer, others do not know the vendor', async (t) => {
  const csms = await startCsms();
  const autel = new SimulatedChargePoint({ url: csms.url, identity: 'AUTEL-1', vendor: 'Autel' });
  t.after(async () => {
    await autel.disconnect();
    await csms.close();
  });
  await autel.connect();
  while (csms.clients.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));

  // The gateway's probe: an Autel lists the lock among its functions.
  const configuration = await csms.clients[0].call('GetConfiguration', {
    key: ['SupportedFunctionLists'],
  });
  assert.match(configuration.configurationKey[0].value, /PerManentLock/);

  const lock = (lockValue) =>
    csms.clients[0].call('DataTransfer', {
      vendorId: 'Autel',
      messageId: 'PermanentLockConnector',
      data: { connectorId: 1, lock: lockValue },
    });
  assert.deepEqual(await lock(true), { status: 'Accepted', data: '{"status":0}' });
  assert.equal(autel.snapshot().connectors[0].permanentLock, true);
  await lock(false);
  assert.equal(autel.snapshot().connectors[0].permanentLock, false);

  await autel.disconnect();
  const other = new SimulatedChargePoint({
    url: csms.url,
    identity: 'OTHER-1',
    vendor: 'Simulator',
  });
  t.after(() => other.disconnect());
  await other.connect();
  while (csms.clients.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  const answer = await csms.clients[1].call('DataTransfer', {
    vendorId: 'Autel',
    messageId: 'PermanentLockConnector',
    data: { connectorId: 1, lock: true },
  });
  assert.equal(answer.status, 'UnknownVendorId');
  const none = await csms.clients[1].call('GetConfiguration', { key: ['SupportedFunctionLists'] });
  assert.deepEqual(none.configurationKey, []);
  assert.equal(other.snapshot().connectors[0].permanentLock, false);
});
