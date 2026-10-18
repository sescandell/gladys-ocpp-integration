// -----------------------------------------------------------------------------
// The Autel vendor module (src/vendors/autel/) and how the generic charge point
// code uses it: extra features, their states, the widget buttons, and the
// command Gladys sends when the user sets the lock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../index.js';
import {
  charger,
  chargerIds,
  chargerStates,
  discoveryShape,
  featureExternalId,
  parseFeatureExternalId,
} from '../../src/devices/charger.js';
import {
  buildChargerWidget,
  normalizeWidgetSettings,
  widgetSignature,
} from '../../src/widgets/charger.js';
import { activeVendors, vendorForCommand, vendorsShape } from '../../src/vendors/index.js';
import { autel } from '../../src/vendors/autel/index.js';
import { normalizeConfig } from '../../src/config.js';
import {
  GATEWAY_SUB_CONTAINER_NAME,
  GATEWAY_OCPP_CONTAINER_PORT,
} from '../../src/gatewayClient.js';

const IDENTITY = 'CP-1';
const NOW = new Date('2026-09-28T12:00:00.000Z');

const connector = (overrides = {}) => ({
  status: 'Available',
  errorCode: 'NoError',
  transactionId: null,
  idTag: null,
  energyActiveImportRegisterWh: 120_000,
  powerActiveImportW: 0,
  powerOfferedW: 7400,
  currentOfferedA: 32,
  currentImportA: 0,
  voltageV: 230,
  lastMeterValueAt: '2026-09-28T11:59:00.000Z',
  lastStatusAt: '2026-09-28T10:00:00.000Z',
  ...overrides,
});

/** A charge point state as the gateway reports it. `lock`: true / false / undefined (unknown). */
const state = ({ supported = true, lock, vendor = 'Autel' } = {}) => ({
  identity: IDENTITY,
  vendor,
  model: 'AC',
  firmwareVersion: '1.0',
  lastSeenAt: '2026-09-28T11:58:00.000Z',
  connectors: { 1: connector() },
  transactions: [],
  history: [],
  extensions: {
    autel: {
      supported,
      connectors: lock === undefined ? {} : { 1: { permanentLock: lock } },
    },
  },
});

const gladys = createFakeGladys();
const ids = chargerIds(gladys, IDENTITY);
const LOCK_FEATURE = featureExternalId(ids, 'permanent-lock', 1);

// --- Which charge points it applies to -----------------------------------------

test('the module applies only where the gateway confirmed the lock', () => {
  assert.equal(autel.matches(state()), true);
  assert.equal(autel.matches(state({ supported: false })), false);
  // The vendor name alone is not enough: the charge point must really have it.
  assert.equal(autel.matches({ vendor: 'Autel', extensions: {} }), false);
  assert.equal(autel.matches({ vendor: 'Autel' }), false);
  assert.equal(autel.matches(undefined), false);
  assert.deepEqual(activeVendors(state()), [autel]);
  assert.deepEqual(activeVendors(state({ supported: false })), []);
});

test('vendorForCommand finds the module owning a writable feature, nothing else', () => {
  assert.equal(vendorForCommand('permanent-lock'), autel);
  assert.equal(vendorForCommand('power'), undefined);
  assert.equal(vendorForCommand('constructor'), undefined);
});

// --- Features and states -----------------------------------------------------------

test('buildDevices: the cable lock is a writable binary switch, only where it applies', async () => {
  const config = normalizeConfig();
  const [withLock] = await charger.buildDevices(gladys, config, async () => ({
    chargers: { [IDENTITY]: state() },
  }));
  const lock = withLock.features.find((f) => f.external_id === LOCK_FEATURE);
  assert.ok(lock, 'the lock feature is offered');
  assert.equal(lock.category, 'switch');
  assert.equal(lock.type, 'binary');
  assert.equal(lock.read_only, false);
  assert.equal(lock.has_feedback, true);
  assert.deepEqual([lock.min, lock.max], [0, 1]);
  assert.equal(withLock.features.length, 7);

  const [without] = await charger.buildDevices(gladys, config, async () => ({
    chargers: { [IDENTITY]: state({ supported: false }) },
  }));
  assert.equal(without.features.length, 6);
});

test('chargerStates: the lock is published once known, never guessed', () => {
  const stateOf = (chargeState) =>
    chargerStates(gladys, IDENTITY, chargeState).find(
      (s) => s.device_feature_external_id === LOCK_FEATURE,
    )?.state;
  assert.equal(stateOf(state({ lock: true })), 1);
  assert.equal(stateOf(state({ lock: false })), 0);
  assert.equal(stateOf(state()), undefined); // supported, no command seen yet
  assert.equal(stateOf(state({ supported: false, lock: true })), undefined);
});

test('Discovery follows the module: its shape changes when the lock gets confirmed', () => {
  assert.notEqual(discoveryShape(state({ supported: false })), discoveryShape(state()));
  assert.equal(vendorsShape(state()), 'autel');
  assert.equal(vendorsShape(state({ supported: false })), '');
});

// --- Widget ------------------------------------------------------------------------

function build(chargeState, { language = 'fr', settings = {} } = {}) {
  return buildChargerWidget({
    ids,
    identity: IDENTITY,
    chargeState,
    options: normalizeWidgetSettings({ connector: 1, ...settings }),
    language,
    now: NOW,
  });
}
const buttons = (content) => content.components.filter((c) => c.type === 'button');

test('widget: both actions while the lock is unknown, bound to the lock feature', () => {
  const content = build(state());
  assert.deepEqual(validateWidgetContent(content), []);
  assert.deepEqual(
    buttons(content).map((b) => [b.value, b.device_feature]),
    [
      [1, LOCK_FEATURE],
      [0, LOCK_FEATURE],
    ],
  );
});

test('widget: a single button, doing the opposite of the known state', () => {
  const locked = build(state({ lock: true }));
  assert.deepEqual(validateWidgetContent(locked), []);
  assert.deepEqual(
    buttons(locked).map((b) => b.value),
    [0],
  );
  assert.equal(buttons(locked)[0].label, 'Déverrouiller le câble');

  const unlocked = build(state({ lock: false }), { language: 'en' });
  assert.deepEqual(
    buttons(unlocked).map((b) => b.value),
    [1],
  );
  assert.equal(buttons(unlocked)[0].label, 'Lock cable');
});

test('widget: no button where the module does not apply, or when controls are turned off', () => {
  assert.equal(buttons(build(state({ supported: false }))).length, 0);
  assert.equal(buttons(build(state(), { settings: { controls: false } })).length, 0);
});

test('widget: the buttons win over the tiles when the content budget is full, and still validate', () => {
  const content = build(state(), {
    settings: {
      tiles: ['power', 'session_energy', 'duration', 'cost', 'offered_power', 'total_energy'],
      chart: 'power',
      details: true,
    },
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.equal(content.components.length, 8);
  assert.equal(buttons(content).length, 2);
});

test('widgetSignature changes when the module data does', () => {
  assert.notEqual(widgetSignature(state()), widgetSignature(state({ lock: true })));
  assert.notEqual(widgetSignature(state({ lock: true })), widgetSignature(state({ lock: false })));
});

// --- Command -----------------------------------------------------------------------

test('parseFeatureExternalId reverses featureExternalId, nothing else', () => {
  assert.deepEqual(parseFeatureExternalId(ids, featureExternalId(ids, 'permanent-lock', 2)), {
    featureKey: 'permanent-lock',
    connectorId: 2,
  });
  assert.equal(parseFeatureExternalId(ids, 'ext:other:charger-station:CP-1:power:1:1'), null);
  assert.equal(parseFeatureExternalId(ids, ids.feature('power:2:1')), null); // unknown evse
  assert.equal(parseFeatureExternalId(ids, ids.feature('power:1:x')), null);
});

const RUNNING_GATEWAY = [
  {
    name: GATEWAY_SUB_CONTAINER_NAME,
    status: 'running',
    ports: [{ container_port: GATEWAY_OCPP_CONTAINER_PORT, host_port: 34000 }],
  },
];

async function setupWithGateway(t) {
  const received = [];
  let answer = { status: 200, body: { success: true } };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      const isCommand = req.url.includes('/commands/');
      res.writeHead(isCommand ? answer.status : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(isCommand ? answer.body : { success: true, chargers: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());

  const fake = createFakeGladys({ containers: RUNNING_GATEWAY });
  registerHandlers(fake, {
    gatewayBaseUrl: `http://127.0.0.1:${server.address().port}`,
    discoveryRefreshIntervalMs: 0,
    eventStreamEnabled: false,
  });
  return {
    fake,
    received,
    answer: (next) => (answer = next),
  };
}

test('setting the lock asks the gateway to run the command, a refusal reaches Gladys', async (t) => {
  const { fake, received, answer } = await setupWithGateway(t);
  const device = { external_id: chargerIds(fake, 'AE 9').device };
  const feature = { external_id: featureExternalId(chargerIds(fake, 'AE 9'), 'permanent-lock', 2) };

  const ack = await fake.fake.setValue(device, feature, 1);
  assert.equal(ack.success, true, ack.error);
  const call = received.find((r) => r.url.includes('/commands/'));
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/api/chargers/AE%209/connectors/2/commands/permanent-lock');
  assert.deepEqual(JSON.parse(call.body), { value: true });

  answer({ status: 502, body: { success: false, error: 'AE 9 refused the lock command' } });
  const refused = await fake.fake.setValue(device, feature, 0);
  assert.equal(refused.success, false);
  assert.match(refused.error, /refused the lock command/);
});

test('every other feature stays read-only, and an invalid value is refused', async (t) => {
  const { fake, received } = await setupWithGateway(t);
  const device = { external_id: chargerIds(fake, IDENTITY).device };

  const power = { external_id: featureExternalId(chargerIds(fake, IDENTITY), 'power', 1) };
  assert.equal((await fake.fake.setValue(device, power, 1)).success, false);

  const lock = { external_id: featureExternalId(chargerIds(fake, IDENTITY), 'permanent-lock', 1) };
  assert.equal((await fake.fake.setValue(device, lock, 5)).success, false);
  assert.equal(
    received.some((r) => r.url.includes('/commands/')),
    false,
  );
});
