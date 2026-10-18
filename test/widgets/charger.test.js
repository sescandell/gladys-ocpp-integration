// -----------------------------------------------------------------------------
// The charger dashboard widget (src/widgets/charger.js): every content it can
// produce must pass the SDK's own validator untouched (`[]` = rendered exactly
// as sent, nothing dropped by the core's budget or vocabulary checks).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '../helpers/fakeGladys.js';
import {
  buildChargerWidget,
  normalizeWidgetSettings,
  TILES,
  formatAgo,
  formatDuration,
  registerChargerWidget,
  widgetSignature,
  CHARGER_WIDGET_KEY,
} from '../../src/widgets/charger.js';
import { chargerIds } from '../../src/devices/charger.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const IDENTITY = 'CP-1';

function connector(overrides = {}) {
  return {
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
  };
}

function chargeState(overrides = {}) {
  return {
    identity: IDENTITY,
    vendor: 'Acme',
    model: 'Wallbox 7',
    firmwareVersion: '1.2.3',
    lastSeenAt: '2026-09-28T11:58:00.000Z',
    connectors: { 1: connector() },
    transactions: [],
    history: [],
    ...overrides,
  };
}

const CLOSED_SESSION = {
  transactionId: 7,
  connectorId: 1,
  idTag: 'tag',
  meterStart: 100_000,
  meterStop: 112_500,
  startedAt: '2026-09-27T22:00:00.000Z',
  stoppedAt: '2026-09-28T01:30:00.000Z',
  stopReason: 'EVDisconnected',
};

function build(
  state,
  { connectorId = 1, language = 'fr', settings = {}, costFeatureHasValue = false } = {},
) {
  const gladys = createFakeGladys();
  return buildChargerWidget({
    ids: chargerIds(gladys, IDENTITY),
    identity: IDENTITY,
    chargeState: state,
    options: normalizeWidgetSettings({ connector: connectorId, ...settings }),
    costFeatureHasValue,
    language,
    now: NOW,
  });
}

const ALL_TILES = Object.values(TILES);

const byType = (content, type) => content.components.filter((c) => c.type === type);
const heading = (content) => content.components.find((c) => c.variant === 'heading').text;

test('every content passes the SDK validator untouched', () => {
  const charging = chargeState({
    connectors: {
      1: connector({
        status: 'Charging',
        transactionId: 8,
        energyActiveImportRegisterWh: 115_000,
      }),
    },
    transactions: [
      {
        ...CLOSED_SESSION,
        transactionId: 8,
        meterStart: 112_500,
        startedAt: '2026-09-28T10:28:00.000Z',
        meterStop: null,
        stoppedAt: null,
      },
    ],
    history: [CLOSED_SESSION],
  });
  const contents = {
    available: build(chargeState()),
    withHistory: build(chargeState({ history: [CLOSED_SESSION] })),
    charging: build(charging),
    chargingEn: build(charging, { language: 'en' }),
    pausedByVehicle: build(
      chargeState({ connectors: { 1: connector({ status: 'SuspendedEV' }) } }),
    ),
    faulted: build(
      chargeState({
        connectors: { 1: connector({ status: 'Faulted', errorCode: 'GroundFailure' }) },
      }),
    ),
    unknownStatus: build(chargeState({ connectors: { 1: connector({ status: 'Unknown' }) } })),
    bareState: build({ identity: IDENTITY, connectors: { 1: { status: 'Preparing' } } }),
    notConnected: build(undefined),
    connectorNeverSeen: build(chargeState(), { connectorId: 2 }),
    // The fullest content the settings allow: 6 tiles + chart + status = 10
    // components on paper, 8 at most on screen only if nothing is dropped.
    allTilesCharging: build(charging, {
      settings: { tiles: ALL_TILES, chart: 'power', kwh_price: 0.2 },
      costFeatureHasValue: true,
    }),
    allTilesFixedPrice: build(chargeState({ history: [CLOSED_SESSION] }), {
      settings: { tiles: ALL_TILES, chart: 'sessions', kwh_price: 0.2, details: false },
    }),
    noTiles: build(charging, { settings: { tiles: [], chart: 'none', details: false } }),
    weekCurve: build(chargeState(), { settings: { chart: 'power', chart_interval: 'last-week' } }),
  };
  for (const [name, content] of Object.entries(contents)) {
    assert.deepEqual(validateWidgetContent(content), [], `${name} must render as sent`);
  }
});

test('charging: heading carries the session duration, tiles the session energy', () => {
  const content = build(
    chargeState({
      connectors: {
        1: connector({
          status: 'Charging',
          transactionId: 8,
          energyActiveImportRegisterWh: 115_000,
        }),
      },
      transactions: [
        {
          transactionId: 8,
          connectorId: 1,
          meterStart: 112_500,
          startedAt: '2026-09-28T10:28:00.000Z',
        },
      ],
    }),
  );
  assert.equal(heading(content), 'En charge · 1 h 32');
  const tiles = byType(content, 'value');
  assert.equal(tiles.find((t) => t.label === 'Session').value, 2.5);
  assert.equal(tiles.find((t) => t.label === 'Durée').value, '1 h 32');
});

test('tiles bound to features: live power, total energy, and the core-derived cost once priced', () => {
  const content = build(chargeState(), {
    settings: { tiles: ALL_TILES },
    costFeatureHasValue: true,
  });
  const ids = chargerIds(createFakeGladys(), IDENTITY);
  const bound = byType(content, 'value')
    .filter((t) => t.device_feature)
    .map((t) => t.device_feature);
  assert.deepEqual(bound, [
    ids.feature('power:1:1'),
    `${ids.feature('energy:1:1')}_cost`,
    ids.feature('energy:1:1'),
  ]);
});

test('cost: Gladys first, then the fixed price, otherwise no tile at all', () => {
  const idle = chargeState({ history: [CLOSED_SESSION] });
  const costTile = (content) => byType(content, 'value').find((t) => t.icon === 'credit-card');

  // Energy screen set up: the live 30-minute cost, whatever the fixed price.
  const priced = costTile(build(idle, { settings: { kwh_price: 0.2 }, costFeatureHasValue: true }));
  assert.equal(priced.label, 'Coût (30 min)');

  // Not set up, a price given: last session energy x price.
  const fixed = costTile(build(idle, { settings: { kwh_price: 0.2 } }));
  assert.equal(fixed.value, 2.5); // 12.5 kWh x 0.20
  assert.equal(fixed.unit, '€');

  // Neither: no forever-empty tile.
  assert.equal(costTile(build(idle)), undefined);
});

test('tiles follow the setting, in a fixed order, hidden when there is nothing to show', () => {
  const labels = (content) => byType(content, 'value').map((t) => t.label);
  // Selection order does not matter; no session yet -> no energy/duration tiles.
  assert.deepEqual(
    labels(build(chargeState(), { settings: { tiles: ['offered_power', 'duration', 'power'] } })),
    ['Puissance', 'Puissance max'],
  );
  assert.deepEqual(labels(build(chargeState(), { settings: { tiles: [] } })), []);
});

test('content budget: chart and details win over the 6th tile, the caption goes first', () => {
  const content = build(chargeState({ history: [CLOSED_SESSION] }), {
    settings: { tiles: ALL_TILES, chart: 'sessions', kwh_price: 0.2 },
    costFeatureHasValue: true,
  });
  assert.equal(content.components.length, 8);
  assert.equal(byType(content, 'value').length, 5);
  assert.equal(byType(content, 'chart').length, 1);
  assert.equal(byType(content, 'status').length, 1);
  assert.equal(
    content.components.find((c) => c.variant === 'caption'),
    undefined,
  );

  // Room to spare: the caption is back.
  const roomy = build(chargeState(), { settings: { details: false } });
  assert.ok(roomy.components.find((c) => c.variant === 'caption'));
  assert.deepEqual(byType(roomy, 'status'), []);
});

test('chart setting: forced power curve with its period, or none', () => {
  const [curve] = byType(
    build(chargeState(), { settings: { chart: 'power', chart_interval: 'last-week' } }),
    'chart',
  );
  assert.equal(curve.interval, 'last-week');
  assert.deepEqual(
    byType(
      build(chargeState({ connectors: { 1: connector({ status: 'Charging' }) } }), {
        settings: { chart: 'none' },
      }),
      'chart',
    ),
    [],
  );
});

test('normalizeWidgetSettings: bad or missing values fall back to the defaults', () => {
  assert.deepEqual(normalizeWidgetSettings({}), {
    connector: 1,
    tiles: ['power', 'session_energy', 'duration', 'cost'],
    chart: 'auto',
    chartInterval: 'last-twelve-hours',
    kwhPrice: null,
    details: true,
  });
  const odd = normalizeWidgetSettings({
    connector: 0,
    tiles: ['cost', 'bogus', 'power'],
    chart: 'pie',
    chart_interval: 'last-decade',
    kwh_price: -1,
    details: 'no',
  });
  assert.equal(odd.connector, 1);
  assert.deepEqual(odd.tiles, ['power', 'cost']);
  assert.equal(odd.chart, 'auto');
  assert.equal(odd.chartInterval, 'last-twelve-hours');
  assert.equal(odd.kwhPrice, null);
  assert.equal(odd.details, true);
});

test('handler: the cost tile appears only once Gladys has priced the connector', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const gladys = createFakeGladys();
  const ids = chargerIds(gladys, IDENTITY);
  let lastValue = null;
  gladys.getDevices = async () => [
    {
      external_id: ids.device,
      features: [{ external_id: `${ids.feature('energy:1:1')}_cost`, last_value: lastValue }],
    },
  ];
  registerChargerWidget(gladys, async () => ({ chargers: { [IDENTITY]: chargeState() } }));
  const handler = gladys.handlers.widgets[CHARGER_WIDGET_KEY];
  const costTile = (content) => byType(content, 'value').find((t) => t.icon === 'credit-card');

  assert.equal(costTile(await handler({ settings: { device: ids.device } })), undefined);
  lastValue = 0.42;
  // The device list is cached for a short while (it lists every device).
  assert.equal(costTile(await handler({ settings: { device: ids.device } })), undefined);
  t.mock.timers.tick(31_000);
  assert.ok(costTile(await handler({ settings: { device: ids.device } })));

  gladys.getDevices = async () => {
    throw new Error('host API down');
  };
  t.mock.timers.tick(31_000);
  assert.equal(costTile(await handler({ settings: { device: ids.device } })), undefined);
});

test('chart: live power curve during a session, recent sessions otherwise', () => {
  const ids = chargerIds(createFakeGladys(), IDENTITY);
  const [live] = byType(
    build(chargeState({ connectors: { 1: connector({ status: 'SuspendedEVSE' }) } })),
    'chart',
  );
  assert.deepEqual(live.device_features, [ids.feature('power:1:1')]);

  const [recent] = byType(
    build(chargeState({ history: [CLOSED_SESSION, { ...CLOSED_SESSION, connectorId: 2 }] })),
    'chart',
  );
  assert.equal(recent.chart_type, 'bar');
  assert.deepEqual(recent.series[0].points, [{ t: CLOSED_SESSION.startedAt, v: 12.5 }]);

  assert.deepEqual(byType(build(chargeState()), 'chart'), [], 'no session, no chart');
});

test('idle with history: last session energy and duration, when it ended', () => {
  const content = build(chargeState({ history: [CLOSED_SESSION] }));
  const tiles = byType(content, 'value');
  assert.equal(tiles.find((t) => t.label === 'Dernière session').value, 12.5);
  assert.equal(tiles.find((t) => t.label === 'Durée').value, '3 h 30');
  const [status] = byType(content, 'status');
  assert.equal(status.items.find((i) => i.label === 'Dernière session finie').value, 'il y a 10 h');
});

test('status: error code only when there is one, offered limit, hardware', () => {
  const [ok] = byType(build(chargeState()), 'status');
  assert.equal(
    ok.items.find((i) => i.label === 'Erreur'),
    undefined,
  );
  assert.equal(ok.items.find((i) => i.label === 'Limite offerte').value, '7,4 kW · 32 A');
  assert.equal(ok.items.find((i) => i.label === 'Borne').value, 'Acme Wallbox 7');

  const [faulted] = byType(
    build(
      chargeState({
        connectors: { 1: connector({ status: 'Faulted', errorCode: 'GroundFailure' }) },
      }),
    ),
    'status',
  );
  const error = faulted.items.find((i) => i.label === 'Erreur');
  assert.equal(error.value, 'GroundFailure');
  assert.equal(error.color, 'danger');
});

test('another connector of the same charge point is shown on its own', () => {
  const content = build(
    chargeState({ connectors: { 1: connector(), 2: connector({ status: 'Charging' }) } }),
    { connectorId: 2, language: 'en' },
  );
  assert.equal(heading(content), 'Charging');
  const ids = chargerIds(createFakeGladys(), IDENTITY);
  assert.equal(byType(content, 'value')[0].device_feature, ids.feature('power:1:2'));
});

test('formatDuration / formatAgo', () => {
  assert.equal(formatDuration(42 * 60_000), '42 min');
  assert.equal(formatDuration(65 * 60_000), '1 h 05');
  assert.equal(formatAgo(10_000, 'fr'), "à l'instant");
  assert.equal(formatAgo(12 * 60_000, 'en'), '12 min ago');
  assert.equal(formatAgo(3 * 3_600_000, 'fr'), 'il y a 3 h');
  assert.equal(formatAgo(3 * 86_400_000, 'en'), '3 d ago');
});

test('widgetSignature ignores meter values, follows status and sessions', () => {
  const base = chargeState();
  const meterOnly = chargeState({
    connectors: {
      1: connector({ powerActiveImportW: 7000, energyActiveImportRegisterWh: 130_000 }),
    },
  });
  assert.equal(widgetSignature(meterOnly), widgetSignature(base));
  assert.notEqual(
    widgetSignature(chargeState({ connectors: { 1: connector({ status: 'Preparing' }) } })),
    widgetSignature(base),
  );
  assert.notEqual(
    widgetSignature(chargeState({ history: [CLOSED_SESSION] })),
    widgetSignature(base),
  );
});

test('handler: resolves the device setting, reads the gateway, defaults to connector 1', async () => {
  const gladys = createFakeGladys();
  registerChargerWidget(gladys, async () => ({ chargers: { [IDENTITY]: chargeState() } }));
  const handler = gladys.handlers.widgets[CHARGER_WIDGET_KEY];

  const content = await handler({
    settings: { device: chargerIds(gladys, IDENTITY).device },
    language: 'en',
    units: 'metric',
  });
  assert.equal(heading(content), 'Available');
  assert.match(content.components[1].text, /connector 1/);
});

test('handler: gateway down or unknown device give a valid placeholder, never a throw', async () => {
  const gladys = createFakeGladys();
  registerChargerWidget(gladys, async () => {
    throw new Error('ECONNREFUSED');
  });
  const handler = gladys.handlers.widgets[CHARGER_WIDGET_KEY];

  const down = await handler({
    settings: { device: chargerIds(gladys, IDENTITY).device },
    language: 'fr',
  });
  assert.equal(heading(down), 'Relais injoignable');
  assert.deepEqual(validateWidgetContent(down), []);

  const unknown = await handler({ settings: { device: 'somebody-else:42' }, language: 'fr' });
  assert.equal(heading(unknown), 'Borne introuvable');
  assert.deepEqual(validateWidgetContent(unknown), []);
});

test('widgetSignature changes when a session closes even if the capped history keeps its length', async () => {
  const { widgetSignature } = await import('../../src/widgets/charger.js');
  const full = (id) => ({
    connectors: {},
    history: Array.from({ length: 20 }, (_, i) => ({
      transactionId: id - i,
      stoppedAt: `2026-01-01T00:00:${String(id - i).padStart(2, '0')}Z`,
    })),
  });
  assert.notEqual(widgetSignature(full(30)), widgetSignature(full(31)));
  assert.equal(widgetSignature(full(30)), widgetSignature(full(30)));
});

test('a stale transaction on a connector that is Available again is not a live session', () => {
  const stale = {
    ...CLOSED_SESSION,
    transactionId: 9,
    startedAt: '2026-09-28T10:00:00.000Z',
    meterStop: null,
    stoppedAt: null,
  };
  const content = build(chargeState({ transactions: [stale], history: [CLOSED_SESSION] }), {
    settings: { tiles: ALL_TILES },
  });
  const labels = byType(content, 'value').map((tile) => JSON.stringify(tile.label));
  assert.ok(
    labels.every((label) => !/Session"|"Session/.test(label) || /Dernière|Last/.test(label)),
  );
  assert.equal(heading(content), 'Disponible');
  assert.deepEqual(validateWidgetContent(content), []);
});

test('normalizeWidgetSettings enforces the manifest bounds', () => {
  assert.equal(normalizeWidgetSettings({ connector: 10 }).connector, 10);
  assert.equal(normalizeWidgetSettings({ connector: 11 }).connector, 1);
  assert.equal(normalizeWidgetSettings({ kwh_price: 10 }).kwhPrice, 10);
  assert.equal(normalizeWidgetSettings({ kwh_price: 11 }).kwhPrice, null);
});
