// -----------------------------------------------------------------------------
// Dashboard widget: ONE connector of ONE charge point.
//
// Declared in the manifest `widgets` (key `charger`), produced at runtime in
// the core's declarative vocabulary (no HTML, the core renders it - see the
// SDK README's "Dashboard widgets").
//
// What it shows, within the core's content budget (8 components), each part
// chosen by the user in the widget settings (SETTINGS below, defaults in the
// manifest):
//   - a heading (what the connector is doing right now) and a caption (which
//     charge point / connector) - always,
//   - up to 6 tiles (`tiles`): power, session energy, duration, cost, offered
//     power, total energy,
//   - one chart (`chart`, `chart_interval`): the live power curve and/or the
//     energy of the recent sessions,
//   - one status list (`details`): connector state, offered limit, error
//     code, last session, last message, hardware.
//
// Cost, in order of preference:
//   1. `<energy feature>_cost`, a feature the CORE derives on its own for every
//      cumulative energy index an external integration publishes (30-minute
//      cost priced with the user's energy contracts - peak/off-peak, Tempo...).
//      The feature always exists, but only ever gets a value when the user
//      set up the Energy screen: the tile is only shown once it has one
//      (`costFeatureHasValue`), never as a forever-empty tile.
//   2. otherwise the session energy times the `kwh_price` setting, when set.
//   3. otherwise no cost tile at all.
//
// Everything else comes from the gateway's GET /api/state, read on each pull
// (cached by the core for `ttl_seconds`, nudged by index.js whenever
// `widgetSignature` changes).
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { fetchGatewayState } from '../gatewayClient.js';
import {
  chargerIds,
  featureExternalId,
  FEATURE,
  identityFromDeviceExternalId,
} from '../devices/charger.js';

export const CHARGER_WIDGET_KEY = 'charger';

/** How long the core may serve a cached content (session energy moves every meter value). */
const TTL_SECONDS = 60;
/** Content budget of the core: components beyond it are dropped. */
const MAX_COMPONENTS = 8;
// Bounds declared in the manifest (test/manifest.test.js keeps them in sync).
const MIN_CONNECTOR = 1;
const MAX_CONNECTOR = 10;
const MAX_KWH_PRICE = 10;
const DEFAULT_CONNECTOR_ID = 1;

/**
 * Option values of the widget settings - mirrored by the manifest, whose
 * `options` and `default` must stay in sync (test/manifest.test.js). Never
 * rename one: saved widgets store them.
 */
export const TILES = {
  POWER: 'power',
  SESSION_ENERGY: 'session_energy',
  DURATION: 'duration',
  COST: 'cost',
  OFFERED_POWER: 'offered_power',
  TOTAL_ENERGY: 'total_energy',
};
export const CHART_MODES = { AUTO: 'auto', POWER: 'power', SESSIONS: 'sessions', NONE: 'none' };
export const CHART_INTERVALS = [
  'last-hour',
  'last-twelve-hours',
  'last-day',
  'last-three-days',
  'last-week',
];
export const DEFAULT_SETTINGS = {
  connector: DEFAULT_CONNECTOR_ID,
  tiles: [TILES.POWER, TILES.SESSION_ENERGY, TILES.DURATION, TILES.COST],
  chart: CHART_MODES.AUTO,
  chart_interval: 'last-twelve-hours',
  details: true,
};

/** Statuses during which a session is going on: the chart shows the live power curve. */
const SESSION_STATUSES = new Set(['Charging', 'SuspendedEV', 'SuspendedEVSE']);

const logger = createLogger({ name: 'charger-widget' });

// OCPP 1.6 ChargePointStatus -> what the connector is doing, in plain words.
// Headings are capped at 40 characters by the core.
const STATUS_TEXT = {
  Available: { en: 'Available', fr: 'Disponible', color: WIDGET_COLORS.SUCCESS },
  Preparing: { en: 'Vehicle plugged in', fr: 'Véhicule branché', color: WIDGET_COLORS.INFO },
  Charging: { en: 'Charging', fr: 'En charge', color: WIDGET_COLORS.PRIMARY },
  SuspendedEV: { en: 'Paused by vehicle', fr: 'En pause (véhicule)', color: WIDGET_COLORS.WARNING },
  SuspendedEVSE: {
    en: 'Paused by charge point',
    fr: 'En pause (borne)',
    color: WIDGET_COLORS.WARNING,
  },
  Finishing: { en: 'Charge complete', fr: 'Charge terminée', color: WIDGET_COLORS.INFO },
  Reserved: { en: 'Reserved', fr: 'Réservée', color: WIDGET_COLORS.INFO },
  Unavailable: { en: 'Unavailable', fr: 'Indisponible', color: WIDGET_COLORS.NEUTRAL },
  Faulted: { en: 'Faulted', fr: 'En défaut', color: WIDGET_COLORS.DANGER },
};
const UNKNOWN_STATUS = { en: 'Unknown state', fr: 'État inconnu', color: WIDGET_COLORS.NEUTRAL };

/** Picks the user's language (fr or en, the two this integration ships). */
function translator(language) {
  const lang = typeof language === 'string' && language.startsWith('fr') ? 'fr' : 'en';
  return {
    lang,
    t: (texts) => texts[lang],
    number: (value, maximumFractionDigits = 1) =>
      new Intl.NumberFormat(lang, { maximumFractionDigits }).format(value),
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** `42 min`, `1 h 05` - fits the 12-character tile value. */
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** `just now`, `12 min ago`, `3 h ago`, `2 d ago` - relative, so no timezone at play. */
export function formatAgo(ms, lang) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  let amount;
  if (minutes < 1) return lang === 'fr' ? "à l'instant" : 'just now';
  if (minutes < 60) amount = `${minutes} min`;
  else if (minutes < 48 * 60) amount = `${Math.floor(minutes / 60)} h`;
  else
    amount = lang === 'fr' ? `${Math.floor(minutes / 1440)} j` : `${Math.floor(minutes / 1440)} d`;
  return lang === 'fr' ? `il y a ${amount}` : `${amount} ago`;
}

function sinceMs(iso, now) {
  const at = Date.parse(iso ?? '');
  return Number.isNaN(at) ? null : now.getTime() - at;
}

function sessionEnergyKwh(meterStart, meterEnd) {
  if (typeof meterStart !== 'number' || typeof meterEnd !== 'number') return null;
  const wh = meterEnd - meterStart;
  return wh >= 0 ? round(wh / 1000, 2) : null;
}

/** Closed sessions of one connector, oldest first (the gateway keeps them most recent first). */
function closedSessions(chargeState, connectorId) {
  return (chargeState.history ?? [])
    .filter((record) => record.connectorId === connectorId && record.stoppedAt)
    .reverse();
}

/**
 * A content made of a heading and a caption only: every case where there is
 * nothing to measure (gateway down, charge point never seen...). A valid
 * content, never an error: the core renders it like any other.
 */
function messageContent(heading, caption) {
  return {
    ttl_seconds: TTL_SECONDS,
    components: [
      { type: 'text', variant: 'heading', text: heading },
      { type: 'text', variant: 'caption', text: caption },
    ],
  };
}

/**
 * The widget settings, validated by the core against the manifest (defaults
 * applied there too) - re-checked here so a malformed or older payload still
 * yields a sensible widget rather than a crash.
 * @param {object} [settings]
 */
export function normalizeWidgetSettings(settings = {}) {
  const connector = Number(settings.connector);
  const tileValues = Object.values(TILES);
  return {
    connector:
      Number.isInteger(connector) && connector >= MIN_CONNECTOR && connector <= MAX_CONNECTOR
        ? connector
        : DEFAULT_SETTINGS.connector,
    tiles: Array.isArray(settings.tiles)
      ? tileValues.filter((tile) => settings.tiles.includes(tile)) // canonical order
      : DEFAULT_SETTINGS.tiles,
    chart: Object.values(CHART_MODES).includes(settings.chart)
      ? settings.chart
      : DEFAULT_SETTINGS.chart,
    chartInterval: CHART_INTERVALS.includes(settings.chart_interval)
      ? settings.chart_interval
      : DEFAULT_SETTINGS.chart_interval,
    kwhPrice:
      typeof settings.kwh_price === 'number' &&
      settings.kwh_price > 0 &&
      settings.kwh_price <= MAX_KWH_PRICE
        ? settings.kwh_price
        : null,
    details: typeof settings.details === 'boolean' ? settings.details : DEFAULT_SETTINGS.details,
  };
}

/**
 * Builds the widget content for one connector. Pure function: what the tests
 * check against the SDK's own validator (test/widgets/charger.test.js).
 * @param {object} args
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} args.ids
 * @param {string} args.identity OCPP identity of the charge point
 * @param {object|undefined} args.chargeState ChargerState JSON from the gateway
 * @param {ReturnType<typeof normalizeWidgetSettings>} [args.options]
 * @param {boolean} [args.costFeatureHasValue] Gladys has priced this connector at least once
 * @param {string} [args.language]
 * @param {Date} [args.now]
 */
export function buildChargerWidget({
  ids,
  identity,
  chargeState,
  options = normalizeWidgetSettings(),
  costFeatureHasValue = false,
  language,
  now = new Date(),
}) {
  const { lang, t, number } = translator(language);
  const connectorId = options.connector;
  const caption = t({
    en: `${identity} · connector ${connectorId}`,
    fr: `${identity} · connecteur ${connectorId}`,
  });

  if (!chargeState) {
    return messageContent(
      t({ en: 'Charge point not connected', fr: 'Borne non connectée' }),
      t({
        en: `${identity} hasn't connected since the integration started.`,
        fr: `${identity} ne s'est pas connectée depuis le démarrage de l'intégration.`,
      }),
    );
  }
  const connector = chargeState.connectors?.[connectorId];
  if (!connector) {
    return messageContent(
      t({
        en: `Connector ${connectorId} not seen yet`,
        fr: `Connecteur ${connectorId} pas encore vu`,
      }),
      caption,
    );
  }

  const status = STATUS_TEXT[connector.status] ?? UNKNOWN_STATUS;
  const inSession = SESSION_STATUSES.has(connector.status);
  // Matched on the connector's own transactionId: after a charge point reboot
  // the gateway may keep a stale record for a connector that is Available again.
  const activeTransaction = (chargeState.transactions ?? []).find(
    (record) =>
      record.connectorId === connectorId &&
      connector.transactionId != null &&
      record.transactionId === connector.transactionId,
  );
  const sessions = closedSessions(chargeState, connectorId);
  const lastSession = sessions.at(-1);

  // --- Heading: what the connector is doing, and for how long when charging.
  const sessionMs = activeTransaction ? sinceMs(activeTransaction.startedAt, now) : null;
  const heading =
    inSession && sessionMs !== null ? `${t(status)} · ${formatDuration(sessionMs)}` : t(status);

  // --- Tiles, in the canonical order of TILES, each only when it has something to show.
  const powerFeature = featureExternalId(ids, FEATURE.POWER, connectorId);
  const energyFeature = featureExternalId(ids, FEATURE.ENERGY, connectorId);
  const energy = activeTransaction
    ? sessionEnergyKwh(activeTransaction.meterStart, connector.energyActiveImportRegisterWh)
    : sessionEnergyKwh(lastSession?.meterStart, lastSession?.meterStop);
  const durationMs = activeTransaction
    ? sessionMs
    : lastSession
      ? Date.parse(lastSession.stoppedAt) - Date.parse(lastSession.startedAt)
      : null;

  const tileBuilders = {
    [TILES.POWER]: () => ({
      type: 'value',
      label: t({ en: 'Power', fr: 'Puissance' }),
      icon: 'zap',
      device_feature: powerFeature,
    }),
    [TILES.SESSION_ENERGY]: () =>
      energy === null
        ? null
        : {
            type: 'value',
            label: activeTransaction
              ? t({ en: 'Session', fr: 'Session' })
              : t({ en: 'Last session', fr: 'Dernière session' }),
            icon: 'battery-charging',
            value: energy,
            unit: 'kWh',
          },
    [TILES.DURATION]: () =>
      durationMs === null || Number.isNaN(durationMs)
        ? null
        : {
            type: 'value',
            label: t({ en: 'Duration', fr: 'Durée' }),
            icon: 'clock',
            value: formatDuration(durationMs),
          },
    [TILES.COST]: () => {
      if (costFeatureHasValue) {
        return {
          type: 'value',
          label: t({ en: 'Cost (30 min)', fr: 'Coût (30 min)' }),
          icon: 'credit-card',
          device_feature: `${energyFeature}_cost`,
        };
      }
      if (options.kwhPrice !== null && energy !== null) {
        return {
          type: 'value',
          label: activeTransaction
            ? t({ en: 'Session cost', fr: 'Coût session' })
            : t({ en: 'Last session cost', fr: 'Coût dern. session' }),
          icon: 'credit-card',
          value: round(energy * options.kwhPrice, 2),
          unit: '€',
        };
      }
      return null;
    },
    [TILES.OFFERED_POWER]: () =>
      typeof connector.powerOfferedW === 'number'
        ? {
            type: 'value',
            label: t({ en: 'Max power', fr: 'Puissance max' }),
            icon: 'sliders',
            value: round(connector.powerOfferedW / 1000, 1),
            unit: 'kW',
          }
        : null,
    [TILES.TOTAL_ENERGY]: () => ({
      type: 'value',
      label: t({ en: 'Total energy', fr: 'Énergie totale' }),
      icon: 'activity',
      device_feature: energyFeature,
    }),
  };
  const tiles = options.tiles.map((tile) => tileBuilders[tile]()).filter(Boolean);

  // --- Focal chart.
  const powerChart = () => ({
    type: 'chart',
    title: t({ en: 'Charging power', fr: 'Puissance de charge' }),
    chart_type: 'area',
    device_features: [powerFeature],
    interval: options.chartInterval,
  });
  const sessionsChart = () => {
    const points = sessions
      .map((record) => ({
        t: record.startedAt,
        v: sessionEnergyKwh(record.meterStart, record.meterStop),
      }))
      .filter((point) => point.v !== null && !Number.isNaN(Date.parse(point.t)));
    return points.length === 0
      ? null
      : {
          type: 'chart',
          title: t({ en: 'Recent sessions', fr: 'Sessions récentes' }),
          chart_type: 'bar',
          unit: 'kWh',
          series: [{ name: t({ en: 'Energy', fr: 'Énergie' }), points }],
        };
  };
  const chart = {
    [CHART_MODES.AUTO]: () => (inSession ? powerChart() : sessionsChart()),
    [CHART_MODES.POWER]: powerChart,
    [CHART_MODES.SESSIONS]: sessionsChart,
    [CHART_MODES.NONE]: () => null,
  }[options.chart]();

  // The core keeps at most MAX_COMPONENTS and drops the rest in content
  // order: decide here what gives way. The heading, then what the user turned
  // on (chart, details), then the tiles in the room left, and the caption
  // only if there is still some.
  const statusList = options.details
    ? {
        type: 'status',
        items: statusItems({
          chargeState,
          connector,
          connectorId,
          status,
          activeTransaction,
          lastSession,
          now,
          lang,
          t,
          number,
        }),
      }
    : null;
  const fixed = [chart, statusList].filter(Boolean);
  const shownTiles = tiles.slice(0, MAX_COMPONENTS - 1 - fixed.length);
  const withCaption = 1 + shownTiles.length + fixed.length < MAX_COMPONENTS;
  const components = [
    { type: 'text', variant: 'heading', text: heading },
    ...(withCaption ? [{ type: 'text', variant: 'caption', text: caption }] : []),
    ...shownTiles,
    ...fixed,
  ];
  return { ttl_seconds: TTL_SECONDS, components };
}

/** The `details` status list: connector state, limit, error, last session, last message, hardware. */
function statusItems({
  chargeState,
  connector,
  connectorId,
  status,
  activeTransaction,
  lastSession,
  now,
  lang,
  t,
  number,
}) {
  const items = [
    {
      label: t({ en: `Connector ${connectorId}`, fr: `Connecteur ${connectorId}` }),
      value: t(status),
      color: status.color,
    },
  ];
  const offered = [];
  if (typeof connector.powerOfferedW === 'number') {
    offered.push(`${number(connector.powerOfferedW / 1000)} kW`);
  }
  if (typeof connector.currentOfferedA === 'number') {
    offered.push(`${number(connector.currentOfferedA)} A`);
  }
  if (offered.length > 0) {
    items.push({
      label: t({ en: 'Offered limit', fr: 'Limite offerte' }),
      value: offered.join(' · '),
      icon: 'sliders',
    });
  }
  if (connector.errorCode && connector.errorCode !== 'NoError') {
    items.push({
      label: t({ en: 'Error', fr: 'Erreur' }),
      value: connector.errorCode,
      icon: 'alert-triangle',
      color: WIDGET_COLORS.DANGER,
    });
  }
  if (!activeTransaction && lastSession) {
    const endedMs = sinceMs(lastSession.stoppedAt, now);
    if (endedMs !== null) {
      items.push({
        label: t({ en: 'Last session ended', fr: 'Dernière session finie' }),
        value: formatAgo(endedMs, lang),
        icon: 'flag',
      });
    }
  }
  const seenMs = sinceMs(chargeState.lastSeenAt, now);
  if (seenMs !== null) {
    items.push({
      label: t({ en: 'Last message', fr: 'Dernier message' }),
      value: formatAgo(seenMs, lang),
      icon: 'radio',
    });
  }
  const hardware = [chargeState.vendor, chargeState.model].filter(Boolean).join(' ');
  if (hardware) {
    items.push({ label: t({ en: 'Charge point', fr: 'Borne' }), value: hardware, icon: 'cpu' });
  }
  if (chargeState.firmwareVersion) {
    items.push({ label: 'Firmware', value: chargeState.firmwareVersion, icon: 'package' });
  }
  return items;
}

/**
 * What the widget depends on beyond the device-bound tiles and chart (which
 * the core refreshes on its own): when this changes for a charge point,
 * index.js nudges the core to re-pull every open instance.
 * @param {object} chargeState ChargerState JSON from the gateway
 */
export function widgetSignature(chargeState) {
  const connectors = Object.entries(chargeState?.connectors ?? {}).map(([id, c]) => [
    id,
    c.status,
    c.errorCode,
    c.transactionId,
    c.powerOfferedW,
    c.currentOfferedA,
  ]);
  // The newest closed session, not the history length: the gateway caps the
  // history, so once full the length no longer changes when a session ends.
  const last = chargeState?.history?.[0];
  return JSON.stringify([connectors, last ? [last.transactionId, last.stoppedAt] : null]);
}

const DEVICES_CACHE_MS = 30_000;
/** gladys -> { at, devices }: getDevices() lists every device of the instance. */
const devicesCache = new WeakMap();

async function listDevices(gladys) {
  const cached = devicesCache.get(gladys);
  if (cached && Date.now() - cached.at < DEVICES_CACHE_MS) return cached.devices;
  const devices = await gladys.getDevices();
  devicesCache.set(gladys, { at: Date.now(), devices });
  return devices;
}

/**
 * Has Gladys ever priced this connector? The core derives the `_cost`
 * feature for every charge point, but only fills it when the Energy screen is
 * set up (meter + contract): a feature without any value would render as a
 * forever-empty tile. Any failure reads as "no" - the widget falls back to the
 * fixed price, or shows no cost at all.
 */
async function costFeatureHasValue(gladys, ids, connectorId) {
  const costFeature = `${featureExternalId(ids, FEATURE.ENERGY, connectorId)}_cost`;
  try {
    const devices = await listDevices(gladys);
    const device = devices.find((candidate) => candidate.external_id === ids.device);
    const feature = device?.features?.find((candidate) => candidate.external_id === costFeature);
    return typeof feature?.last_value === 'number';
  } catch (err) {
    logger.warn('Unable to read the devices to find the cost feature', err);
    return false;
  }
}

/**
 * Registers the widget handler.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {Function} [fetchState] overrides how the gateway state is read (tests)
 */
export function registerChargerWidget(gladys, fetchState = fetchGatewayState) {
  gladys.onWidgetGet(CHARGER_WIDGET_KEY, async ({ settings, language } = {}) => {
    const { t } = translator(language);
    const identity = identityFromDeviceExternalId(gladys, settings?.device ?? '');
    if (!identity) {
      return messageContent(
        t({ en: 'Charge point not found', fr: 'Borne introuvable' }),
        t({
          en: 'Pick a charge point in the widget settings.',
          fr: 'Choisissez une borne dans les réglages du widget.',
        }),
      );
    }

    let chargers;
    try {
      ({ chargers } = await fetchState());
    } catch (err) {
      logger.warn(`Gateway unreachable, widget for ${identity} shows a placeholder`, err);
      return messageContent(
        t({ en: 'Gateway unreachable', fr: 'Relais injoignable' }),
        t({
          en: 'The OCPP relay is not answering, retrying shortly.',
          fr: 'Le relais OCPP ne répond pas, nouvel essai sous peu.',
        }),
      );
    }

    const ids = chargerIds(gladys, identity);
    const options = normalizeWidgetSettings(settings);
    return buildChargerWidget({
      ids,
      identity,
      chargeState: chargers?.[identity],
      options,
      costFeatureHasValue: options.tiles.includes(TILES.COST)
        ? await costFeatureHasValue(gladys, ids, options.connector)
        : false,
      language,
    });
  });
}
