import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../helpers/fakeGladys.js';
import {
  charger,
  mapConnectorToStates,
  identityFromDeviceExternalId,
} from '../../src/devices/charger.js';
import { normalizeConfig } from '../../src/config.js';
import { serializeChargersStore } from '../../src/chargers.js';

const ids = {
  device: 'ext:test:charger-station:CP-1',
  feature: (key) => `ext:test:charger-station:CP-1:${key}`,
};

test('mapConnectorToStates: null/undefined connector -> no states', () => {
  assert.deepEqual(mapConnectorToStates(ids, 1, null), []);
  assert.deepEqual(mapConnectorToStates(ids, 1, undefined), []);
});

// Reads the value of one feature out of a mapConnectorToStates() result.
function stateOf(states, featureKey) {
  return states.find((s) => s.device_feature_external_id === ids.feature(featureKey))?.state;
}

test('mapConnectorToStates: OCPP 1.6 status split across connector status + charging state', () => {
  const expected = {
    Available: [0, 4], // AVAILABLE   / IDLE
    Preparing: [1, 1], // OCCUPIED    / EV_CONNECTED
    Charging: [1, 0], // OCCUPIED     / CHARGING
    SuspendedEVSE: [1, 3], // OCCUPIED / PAUSED_BY_CHARGER
    SuspendedEV: [1, 2], // OCCUPIED   / PAUSED_BY_VEHICLE
    Finishing: [1, 4], // OCCUPIED    / IDLE
    Reserved: [2, 4], // RESERVED     / IDLE
    Unavailable: [3, 4], // UNAVAILABLE / IDLE
    Faulted: [4, 4], // FAULTED      / IDLE
  };

  for (const [status, [connectorStatus, chargingState]] of Object.entries(expected)) {
    const states = mapConnectorToStates(ids, 1, { status });
    assert.equal(stateOf(states, 'connector-status:1'), connectorStatus, `${status} connector`);
    assert.equal(stateOf(states, 'charging-state:1'), chargingState, `${status} charging state`);
  }
});

test('mapConnectorToStates: states are scoped to the connector id', () => {
  const states = mapConnectorToStates(ids, 2, { status: 'Charging' });
  assert.equal(stateOf(states, 'connector-status:2'), 1);
  assert.equal(stateOf(states, 'charging-state:2'), 0);
  assert.equal(stateOf(states, 'connector-status:1'), undefined);
});

test('mapConnectorToStates: an unknown status publishes neither enum feature', () => {
  // "Unknown" is what the gateway seeds a connector with before its first
  // StatusNotification.
  for (const status of ['Unknown', 'SomeVendorStatus', undefined]) {
    const states = mapConnectorToStates(ids, 1, { status });
    assert.equal(stateOf(states, 'connector-status:1'), undefined, `${status}`);
    assert.equal(stateOf(states, 'charging-state:1'), undefined, `${status}`);
  }
});

test('mapConnectorToStates: numeric measurements converted to the right unit', () => {
  const states = mapConnectorToStates(ids, 1, {
    status: 'Charging',
    powerActiveImportW: 7200,
    currentImportA: 16,
    voltageV: 230,
    energyActiveImportRegisterWh: 1500,
  });
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('power:1')).state,
    7.2,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('current:1')).state,
    16,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('voltage:1')).state,
    230,
  );
  assert.equal(
    states.find((s) => s.device_feature_external_id === ids.feature('energy:1')).state,
    1.5,
  );
});

test('mapConnectorToStates: missing numeric measurements are not published', () => {
  const states = mapConnectorToStates(ids, 1, { status: 'Available' });
  assert.equal(
    states.some((s) => s.device_feature_external_id === ids.feature('power:1')),
    false,
  );
});

test('ownsDevice: true for a charger device of this integration, false otherwise', () => {
  const gladys = createFakeGladys();
  assert.equal(charger.ownsDevice(gladys, 'charger-station:CP-1'), true);
  assert.equal(charger.ownsDevice(gladys, 'some-other-device:xyz'), false);
});

test('identityFromDeviceExternalId: recovers the OCPP identity from a device external_id', () => {
  const gladys = createFakeGladys();
  // Exactly the round trip the add_charger action relies on: Gladys's
  // `source: "devices"` select hands back an external_id, everything else
  // works in OCPP identities.
  const externalId = gladys.externalIds('charger-station', 'CP-1').device;
  assert.equal(identityFromDeviceExternalId(gladys, externalId), 'CP-1');
});

test('identityFromDeviceExternalId: an identity containing separators survives the round trip', () => {
  const gladys = createFakeGladys();
  // Real chargers use serial-number-ish identities; nothing guarantees they
  // avoid the ":" this scheme uses as a separator, and slicing by prefix
  // length (rather than splitting) is what makes that safe.
  const identity = 'CP:1:with:colons';
  const externalId = gladys.externalIds('charger-station', identity).device;
  assert.equal(identityFromDeviceExternalId(gladys, externalId), identity);
});

test('identityFromDeviceExternalId: null for a device that is not one of this blueprint', () => {
  const gladys = createFakeGladys();
  assert.equal(identityFromDeviceExternalId(gladys, 'thermostat:XYZ'), null);
  assert.equal(identityFromDeviceExternalId(gladys, ''), null);
});

function configWithChargers(chargers) {
  return normalizeConfig(serializeChargersStore(chargers));
}

const config = configWithChargers({ 'CP-1': 'wss://cloud.example.com/ocpp' });

test('buildDevices: returns nothing when no charge point is configured', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, normalizeConfig(), async () => ({
    chargers: {},
  }));
  assert.deepEqual(devices, []);
});

test('buildDevices: a configured charge point is offered even when the gateway is unreachable', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => {
    throw new Error('ECONNREFUSED');
  });
  assert.deepEqual(
    devices.map((d) => d.external_id),
    ['charger-station:CP-1'],
  );
  // Seeded with the default connector 1 - nothing was ever observed.
  assert.equal(devices[0].features.length, 6);
});

test('buildDevices: a configured charge point that has never connected is still offered, seeded with connector 1', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  assert.deepEqual(
    devices.map((d) => d.external_id),
    ['charger-station:CP-1'],
  );
  // Fixed at Gladys's "every minute" tier - no longer user-configurable.
  assert.equal(devices[0].poll_frequency, 60_000);
  assert.equal(devices[0].features.length, 6);
  assert.ok(devices[0].features.every((f) => f.external_id.endsWith(':1')));
});

test('buildDevices: every feature declares both min and max (Gladys core requires both, for every category)', async () => {
  // Regression test: Gladys core's t_device_feature.min/max are NOT NULL
  // regardless of feature category (server/models/device_feature.js) - a
  // feature missing either one passes discovery fine (neither the SDK nor
  // publishDiscoveredDevices validate this) but 422s the moment the user
  // actually clicks "Add to Gladys" ("min/max cannot be null"), since only
  // the real device-creation DB insert enforces it.
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  assert.equal(devices[0].features.length, 6);
  for (const feature of devices[0].features) {
    assert.equal(typeof feature.min, 'number', `${feature.name} must declare a numeric min`);
    assert.equal(typeof feature.max, 'number', `${feature.name} must declare a numeric max`);
  }
});

test("buildDevices: connector state uses Gladys's CHARGING_STATION category, bounded to its enums", async () => {
  // Hand-copied strings (the SDK doesn't export the category yet) checked
  // against DB ENUMs at device creation: a typo is a 422, not a warning.
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  const byExternalId = (key) =>
    devices[0].features.find((f) => f.external_id.endsWith(`:${key}:1`));

  const connectorStatus = byExternalId('connector-status');
  assert.equal(connectorStatus.category, 'charging-station');
  assert.equal(connectorStatus.type, 'connector-status');
  assert.equal(connectorStatus.min, 0);
  assert.equal(connectorStatus.max, 4); // AVAILABLE..FAULTED

  const chargingState = byExternalId('charging-state');
  assert.equal(chargingState.category, 'charging-station');
  assert.equal(chargingState.type, 'charging-state');
  assert.equal(chargingState.min, 0);
  assert.equal(chargingState.max, 5); // CHARGING..DISCHARGING

  // The text/binary trio these two replace must not come back alongside.
  for (const gone of ['status', 'plugged', 'charging']) {
    assert.equal(byExternalId(gone), undefined, `${gone} feature must not be published anymore`);
  }
});

test("buildDevices: the measurements are ENERGY_SENSOR, so they reach Gladys's energy monitoring", async () => {
  // That page filters on both category ([energy-sensor, switch,
  // teleinformation]) and type - any other category silently drops the
  // totalizer from the sub-meter picker.
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  const byExternalId = (key) =>
    devices[0].features.find((f) => f.external_id.endsWith(`:${key}:1`));

  const expected = {
    power: { type: 'power', unit: 'kilowatt' },
    current: { type: 'current', unit: 'ampere' },
    voltage: { type: 'voltage', unit: 'volt' },
    energy: { type: 'energy', unit: 'kilowatt-hour' },
  };
  for (const [key, { type, unit }] of Object.entries(expected)) {
    const feature = byExternalId(key);
    assert.ok(feature, `${key} feature must be published`);
    assert.equal(feature.category, 'energy-sensor', `${key} category`);
    assert.equal(feature.type, type, `${key} type`);
    assert.equal(feature.unit, unit, `${key} unit`);
  }
});

test('buildDevices: poll_frequency is always the fixed 60s value Gladys accepts', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  assert.equal(devices[0].poll_frequency, 60_000);
});

test('buildDevices: each device carries its configured origin cloud URL as a param', async () => {
  const gladys = createFakeGladys();
  const devices = await charger.buildDevices(gladys, config, async () => ({ chargers: {} }));
  assert.deepEqual(devices[0].params, [
    { name: 'Origin cloud URL', value: 'wss://cloud.example.com/ocpp' },
  ]);
});

test('buildDevices: one device for the charge point, features for every physical connector, connector 0 excluded', async () => {
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
  assert.equal(devices.length, 1);
  const [device] = devices;
  assert.equal(device.external_id, 'charger-station:CP-1');
  assert.equal(device.features.length, 12); // 6 per connector x 2 connectors
  assert.ok(device.features.some((f) => f.external_id.endsWith(':1')));
  assert.ok(device.features.some((f) => f.external_id.endsWith(':2')));
  assert.ok(device.features.every((f) => !f.external_id.endsWith(':0')));
});

test('buildDevices: feature set grows as new connectors are observed (re-publish semantics)', async () => {
  const gladys = createFakeGladys();
  const first = await charger.buildDevices(gladys, config, async () => ({
    chargers: { 'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Available' } } } },
  }));
  assert.equal(first[0].features.length, 6);

  const second = await charger.buildDevices(gladys, config, async () => ({
    chargers: {
      'CP-1': {
        identity: 'CP-1',
        connectors: { 1: { status: 'Available' }, 2: { status: 'Available' } },
      },
    },
  }));
  assert.equal(second[0].features.length, 12);
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
  assert.deepEqual(externalIds, ['charger-station:CP-VENDOR-A', 'charger-station:CP-VENDOR-B']);
  const deviceA = devices.find((d) => d.external_id === 'charger-station:CP-VENDOR-A');
  assert.match(deviceA.name, /CP-VENDOR-A/);
  assert.equal(deviceA.features.length, 6);
  assert.deepEqual(deviceA.params, [
    { name: 'Origin cloud URL', value: 'wss://cloud-a.example.com/ocpp' },
  ]);
  const deviceB = devices.find((d) => d.external_id === 'charger-station:CP-VENDOR-B');
  assert.equal(deviceB.features.length, 12);
  assert.deepEqual(deviceB.params, [
    { name: 'Origin cloud URL', value: 'wss://cloud-b.example.com/ocpp' },
  ]);
});

test('buildDevices: a configured charge point that has never connected is offered next to one that has', async () => {
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
  assert.deepEqual(devices.map((d) => d.external_id).sort(), [
    'charger-station:CP-CONNECTED',
    'charger-station:CP-NEVER-SEEN',
  ]);
});

test('buildDevices: an identity only known to the gateway (auto-detected, never configured) still gets a device', async () => {
  const gladys = createFakeGladys();
  const fetchState = async () => ({
    chargers: {
      'CP-AUTO-DETECTED': {
        identity: 'CP-AUTO-DETECTED',
        connectors: { 1: { status: 'Available' } },
      },
    },
  });

  // No config.chargers entry at all - normalizeConfig() with no chargers_json.
  const devices = await charger.buildDevices(gladys, normalizeConfig(), fetchState);
  assert.deepEqual(
    devices.map((d) => d.external_id),
    ['charger-station:CP-AUTO-DETECTED'],
  );
  assert.deepEqual(devices[0].params, [
    { name: 'Origin cloud URL', value: 'Not yet configured - run the "Add a charge point" action' },
  ]);
});

test('onPoll: publishes states for the matching charge point, all its connectors', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'charger-station:CP-1' };
  const fetchState = async () => ({
    chargers: {
      'CP-1': { identity: 'CP-1', connectors: { 1: { status: 'Charging', voltageV: 230 } } },
    },
  });

  await charger.onPoll(gladys, config, device, fetchState);
  assert.ok(
    gladys.published.some((p) => p.featureExternalId.endsWith(':voltage:1') && p.state === 230),
  );
});

test('onPoll: only publishes for the targeted device, not other configured charge points', async () => {
  const gladys = createFakeGladys();
  const multiConfig = configWithChargers({
    'CP-A': 'wss://cloud-a/ocpp',
    'CP-B': 'wss://cloud-b/ocpp',
  });
  const device = { external_id: 'charger-station:CP-A' };
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

test('onPoll: resolves and publishes for a device whose identity was never configured (auto-detected only)', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'charger-station:CP-AUTO-DETECTED' };
  const fetchState = async () => ({
    chargers: {
      'CP-AUTO-DETECTED': {
        identity: 'CP-AUTO-DETECTED',
        connectors: { 1: { status: 'Charging', voltageV: 42 } },
      },
    },
  });

  // normalizeConfig() with no chargers_json - nothing configured.
  await charger.onPoll(gladys, normalizeConfig(), device, fetchState);
  assert.ok(
    gladys.published.some((p) => p.featureExternalId.endsWith(':voltage:1') && p.state === 42),
  );
});

test('onPoll: does nothing when the charge point reports no connector', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'charger-station:CP-1' };
  const fetchState = async () => ({ chargers: { 'CP-1': { identity: 'CP-1', connectors: {} } } });

  await charger.onPoll(gladys, config, device, fetchState);
  assert.equal(gladys.published.length, 0);
});

test('onPoll: does nothing when the gateway knows no charge point at all', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'charger-station:CP-1' };

  await charger.onPoll(gladys, config, device, async () => ({ chargers: {} }));
  assert.equal(gladys.published.length, 0);
});

test('onPoll: does not throw when the gateway is unreachable (transient during startup/restart)', async () => {
  const gladys = createFakeGladys();
  const device = { external_id: 'charger-station:CP-1' };
  const fetchState = async () => {
    throw new Error('connect ECONNREFUSED 172.18.0.3:9080');
  };

  await assert.doesNotReject(() => charger.onPoll(gladys, config, device, fetchState));
  assert.equal(gladys.published.length, 0);
});
