import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../helpers/fakeGladys.js';
import { charger, mapConnectorToStates } from '../../src/devices/charger.js';
import { normalizeConfig } from '../../src/config.js';
import { serializeChargersStore } from '../../src/chargers.js';

const ids = {
  device: 'ext:test:ev-charger-connector:CP-1:1',
  feature: (key) => `ext:test:ev-charger-connector:CP-1:1:${key}`,
};

test('mapConnectorToStates: null/undefined connector -> no states', () => {
  assert.deepEqual(mapConnectorToStates(ids, null), []);
  assert.deepEqual(mapConnectorToStates(ids, undefined), []);
});

test('mapConnectorToStates: status text is always published', () => {
  const states = mapConnectorToStates(ids, { status: 'Available' });
  const status = states.find((s) => s.device_feature_external_id === ids.feature('status'));
  assert.equal(status.text, 'Available');
});

test('mapConnectorToStates: plugged/charging derived from status', () => {
  const charging = mapConnectorToStates(ids, { status: 'Charging' });
  assert.equal(
    charging.find((s) => s.device_feature_external_id === ids.feature('plugged')).state,
    1,
  );
  assert.equal(
    charging.find((s) => s.device_feature_external_id === ids.feature('charging')).state,
    1,
  );

  const available = mapConnectorToStates(ids, { status: 'Available' });
  assert.equal(
    available.find((s) => s.device_feature_external_id === ids.feature('plugged')).state,
    0,
  );
  assert.equal(
    available.find((s) => s.device_feature_external_id === ids.feature('charging')).state,
    0,
  );

  const preparing = mapConnectorToStates(ids, { status: 'Preparing' });
  assert.equal(
    preparing.find((s) => s.device_feature_external_id === ids.feature('plugged')).state,
    1,
  );
  assert.equal(
    preparing.find((s) => s.device_feature_external_id === ids.feature('charging')).state,
    0,
  );
});

test('mapConnectorToStates: numeric measurements converted to the right unit', () => {
  const states = mapConnectorToStates(ids, {
    status: 'Charging',
    powerActiveImportW: 7200,
    currentImportA: 16,
    voltageV: 230,
    energyActiveImportRegisterWh: 1500,
  });
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('power')).state,
    7.2,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('current')).state,
    16,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('voltage')).state,
    230,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('energy')).state,
    1.5,
  );
});

test('mapConnectorToStates: missing numeric measurements are not published', () => {
  const states = mapConnectorToStates(ids, { status: 'Available' });
  assert.equal(
    states.some((s) => s.device_feature_external_id === ids.feature('power')),
    false,
  );
});

test('ownsDevice: true for a connector device of this integration, false otherwise', () => {
  const gladys = createFakeGladys();
  assert.equal(charger.ownsDevice(gladys, 'ev-charger-connector:CP-1:1'), true);
  assert.equal(charger.ownsDevice(gladys, 'some-other-device:xyz'), false);
});

function configWithChargers(chargers, poll_frequency = 30) {
  return normalizeConfig({ ...serializeChargersStore(chargers), poll_frequency });
}

const config = configWithChargers({ 'CP-1': 'wss://cloud.example.com/ocpp' });

test('buildDevices: returns nothing when no charge point is configured', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, normalizeConfig(), async () => ({
    chargers: {},
  }));
  assert.deepEqual(devices, []);
});

test('buildDevices: returns nothing when the gateway is unreachable', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.deepEqual(devices, []);
});

test('buildDevices: returns nothing when a configured charge point has never connected', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  assert.deepEqual(devices, []);
});

test('buildDevices: one device per physical connector, connector 0 excluded', async () => {
  const gladys = createFakeGladys();
  const fetchState = async () => ({
    chargers: {
      'CP-1': {
        identity: 'CP-1',
        lastSeenAt: '2026-08-01T10:00:00.000Z',
        connectors: {
          0: { status: 'Available' },
          1: { status: 'Charging' },
          2: { status: 'Available' },
        },
      },
    },
  });

  const devices = await charger.buildDevices(gladys, config, fetchState);
  const externalIds = devices.map((d) => d.external_id).sort();
  assert.deepEqual(externalIds, ['ev-charger-connector:CP-1:1', 'ev-charger-connector:CP-1:2']);
  for (const device of devices) {
    assert.equal(device.poll_frequency, 30);
    assert.equal(device.features.length, 7);
  }
});

test('buildDevices: connector set grows as new connectors are observed (re-publish semantics)', async () => {
  const gladys = createFakeGladys();
  const first = await charger.buildDevices(gladys, config, async () => ({
    chargers: { 'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Available' } } } },
  }));
  assert.equal(first.length, 1);

  const second = await charger.buildDevices(gladys, config, async () => ({
    chargers: {
      'CP-1': {
        identity: 'CP-1',
        connectors: { 1: { status: 'Available' }, 2: { status: 'Available' } },
      },
    },
  }));
  assert.equal(second.length, 2);
});

test('buildDevices: devices from TWO different configured charge points, no cross-talk', async () => {
  const gladys = createFakeGladys();
  const multiConfig = configWithChargers({
    'CP-VENDOR-A': 'wss://cloud-a.example.com/ocpp',
    'CP-VENDOR-B': 'wss://cloud-b.example.com/ocpp',
  });
  const fetchState = async () => ({
    chargers: {
      'CP-VENDOR-A': { identity: 'CP-VENDOR-A', connectors: { 1: { status: 'Charging' } } },
      'CP-VENDOR-B': {
        identity: 'CP-VENDOR-B',
        connectors: { 1: { status: 'Available' }, 2: { status: 'Available' } },
      },
    },
  });

  const devices = await charger.buildDevices(gladys, multiConfig, fetchState);
  const externalIds = devices.map((d) => d.external_id).sort();
  assert.deepEqual(externalIds, [
    'ev-charger-connector:CP-VENDOR-A:1',
    'ev-charger-connector:CP-VENDOR-B:1',
    'ev-charger-connector:CP-VENDOR-B:2',
  ]);
  const deviceA = devices.find((d) => d.external_id === 'ev-charger-connector:CP-VENDOR-A:1');
  assert.match(deviceA.name, /CP-VENDOR-A/);
});

test('buildDevices: a configured charge point that has never connected is silently skipped, others still show up', async () => {
  const gladys = createFakeGladys();
  const multiConfig = configWithChargers({
    'CP-CONNECTED': 'wss://cloud-a.example.com/ocpp',
    'CP-NEVER-SEEN': 'wss://cloud-b.example.com/ocpp',
  });
  const fetchState = async () => ({
    chargers: {
      'CP-CONNECTED': { identity: 'CP-CONNECTED', connectors: { 1: { status: 'Available' } } },
    },
  });

  const devices = await charger.buildDevices(gladys, multiConfig, fetchState);
  assert.deepEqual(
    devices.map((d) => d.external_id),
    ['ev-charger-connector:CP-CONNECTED:1'],
  );
});

test('onPoll: publishes states for the matching charge point + connector', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'ev-charger-connector:CP-1:1' };
  const fetchState = async () => ({
    chargers: {
      'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Charging', voltageV: 230 } } },
    },
  });

  await charger.onPoll(gladys, config, device, fetchState);
  assert.ok(
    gladys.published.some((p) => p.featureExternalId.endsWith(':voltage') && p.state === 230),
  );
});

test('onPoll: only publishes for the targeted device, not other configured charge points', async () => {
  const gladys = createFakeGladys();
  const multiConfig = configWithChargers({
    'CP-A': 'wss://cloud-a/ocpp',
    'CP-B': 'wss://cloud-b/ocpp',
  });
  const device = { external_id: 'ev-charger-connector:CP-A:1' };
  const fetchState = async () => ({
    chargers: {
      'CP-A': { identity: 'CP-A', connectors: { 1: { status: 'Charging', voltageV: 100 } } },
      'CP-B': { identity: 'CP-B', connectors: { 1: { status: 'Charging', voltageV: 200 } } },
    },
  });

  await charger.onPoll(gladys, multiConfig, device, fetchState);
  assert.ok(gladys.published.every((p) => !p.featureExternalId.includes('CP-B')));
  assert.ok(gladys.published.some((p) => p.featureExternalId.includes('CP-A') && p.state === 100));
});

test('onPoll: does nothing when the device connector is no longer reported', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'ev-charger-connector:CP-1:1' };
  const fetchState = async () => ({ chargers: { 'CP-1': { identity: 'CP-1', connectors: {} } } });

  await charger.onPoll(gladys, config, device, fetchState);
  assert.equal(gladys.published.length, 0);
});

test('onPoll: does nothing when the gateway knows no charge point at all', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'ev-charger-connector:CP-1:1' };

  await charger.onPoll(gladys, config, device, async () => ({ chargers: {} }));
  assert.equal(gladys.published.length, 0);
});

test('onPoll: does not throw when the gateway is unreachable (transient during startup/restart)', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'ev-charger-connector:CP-1:1' };
  const fetchState = async () => {
    throw new Error('connect ECONNREFUSED 172.18.0.3:9080');
  };

  await assert.doesNotReject(() => charger.onPoll(gladys, config, device, fetchState));
  assert.equal(gladys.published.length, 0);
});
