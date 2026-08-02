// -----------------------------------------------------------------------------
// Device type: EV CHARGER.
//
// V1 is READ-ONLY: no onSetValue implemented here -> index.js's generic
// wiring automatically answers "not implemented" if Gladys ever asks.
//
// Data source: GET /api/state of the "gateway" sub-container (see
// ../gatewayClient.js), started and supervised by this integration through
// the SDK (see ../../index.js) - never a direct OCPP connection from this
// process, no risk to the charge point<->origin cloud relay running in the
// sub-container.
//
// ONE Gladys device PER CONFIGURED CHARGE POINT (not per connector): a
// charge point is something the user explicitly declared via the
// `add_charger` action, so it is offered in Discovery as soon as it is
// configured - it does not need to have connected yet. This matches the
// official discovery contract ("your integration never creates or deletes
// devices, it publishes the devices it discovers, and the user decides
// which ones to create" - gladysassistant.com/docs/dev/external-integrations)
// and mirrors how a cloud/account-based integration lists devices from its
// own registry, online or not.
//
// A charge point can have several physical connectors: each one becomes a
// small group of features on the SAME device (`Connector <n> - <label>`),
// not a separate device - `buildDevices()` seeds connector 1 by default
// (the OCPP-conventional first, and only, connector on the vast majority of
// real hardware) so the device has something to show immediately, then
// grows the feature set as the gateway actually observes more connectors
// via StatusNotification. Growing the feature list of an ALREADY CREATED
// device surfaces as an "Update" button in Gladys (see
// `publishDiscoveredDevices`'s doc comment in the SDK) - the user stays in
// control of structural changes, same as day one.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchGatewayState } from '../gatewayClient.js';

const DEVICE_TYPE = 'ev-charger';

const logger = createLogger({ name: DEVICE_TYPE });

const FEATURE = {
  STATUS: 'status',
  PLUGGED: 'plugged',
  CHARGING: 'charging',
  POWER: 'power',
  CURRENT: 'current',
  VOLTAGE: 'voltage',
  ENERGY: 'energy',
};

// OCPP 1.6 StatusNotification values meaning "cable plugged in" - anything
// else (Available, Unavailable, Faulted) means unplugged.
const PLUGGED_STATUSES = new Set([
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
]);

// OCPP connector 0 represents the charge point as a whole, never a physical
// connector - always excluded from the feature set.
const AGGREGATE_CONNECTOR_ID = 0;

// Seeded when a charge point is configured but the gateway hasn't observed
// any connector yet - the OCPP-conventional first (and, for most real
// hardware, only) connector.
const DEFAULT_CONNECTOR_ID = 1;

// A discovered device's poll_frequency is NOT a free number: Gladys core
// rejects (and fails the ENTIRE publishDiscoveredDevices call, for every
// device in the batch) any value other than these exact milliseconds,
// verified against server/utils/constants.js's DEVICE_POLL_FREQUENCIES.
// The manifest's poll_frequency config field is a matching `select` (values
// in seconds, see gladys-assistant-integration.json) precisely so this list
// stays in sync - but snapping defensively here means a stale config value
// saved under an older, laxer version of that field can never reproduce the
// same failure again.
const DEVICE_POLL_FREQUENCIES_SECONDS = [1, 2, 10, 15, 30, 60];

function toDevicePollFrequencyMs(seconds) {
  const nearest = DEVICE_POLL_FREQUENCIES_SECONDS.reduce((best, candidate) =>
    Math.abs(candidate - seconds) < Math.abs(best - seconds) ? candidate : best,
  );
  return nearest * 1000;
}

/**
 * Translates one ConnectorState into Gladys feature states, scoped to
 * `connectorId` (a device carries one such group of features PER physical
 * connector). Pure function (no network call): what is unit-tested without
 * a real SDK/gateway connection, see test/devices/charger.test.js.
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} ids
 * @param {number} connectorId
 * @param {object|null} connector ConnectorState from the gateway (or null/undefined)
 * @returns {Array<{device_feature_external_id: string, state?: number, text?: string}>}
 */
export function mapConnectorToStates(ids, connectorId, connector) {
  if (!connector) return [];

  const states = [];
  const push = (featureKey, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    states.push({
      device_feature_external_id: ids.feature(`${featureKey}:${connectorId}`),
      state: value,
    });
  };

  states.push({
    device_feature_external_id: ids.feature(`${FEATURE.STATUS}:${connectorId}`),
    text: connector.status ?? 'Unknown',
  });
  push(FEATURE.PLUGGED, PLUGGED_STATUSES.has(connector.status) ? 1 : 0);
  push(FEATURE.CHARGING, connector.status === 'Charging' ? 1 : 0);

  if (typeof connector.powerActiveImportW === 'number') {
    push(FEATURE.POWER, Math.round((connector.powerActiveImportW / 1000) * 100) / 100);
  }
  if (typeof connector.currentImportA === 'number') {
    push(FEATURE.CURRENT, connector.currentImportA);
  }
  if (typeof connector.voltageV === 'number') {
    push(FEATURE.VOLTAGE, connector.voltageV);
  }
  if (typeof connector.energyActiveImportRegisterWh === 'number') {
    push(FEATURE.ENERGY, Math.round((connector.energyActiveImportRegisterWh / 1000) * 1000) / 1000);
  }

  return states;
}

function buildConnectorFeatures(ids, connectorId) {
  const label = (text) => `Connector ${connectorId} - ${text}`;
  return [
    {
      name: label('Status'),
      external_id: ids.feature(`${FEATURE.STATUS}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.TEXT,
      type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Plugged'),
      external_id: ids.feature(`${FEATURE.PLUGGED}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Charging'),
      external_id: ids.feature(`${FEATURE.CHARGING}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ON,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Charging power'),
      external_id: ids.feature(`${FEATURE.POWER}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER,
      unit: DEVICE_FEATURE_UNITS.KILOWATT,
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Charging current'),
      external_id: ids.feature(`${FEATURE.CURRENT}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Voltage'),
      external_id: ids.feature(`${FEATURE.VOLTAGE}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Total energy'),
      external_id: ids.feature(`${FEATURE.ENERGY}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
      type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_ADDED_TOTAL,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];
}

function observedConnectorIds(chargeState) {
  return Object.keys(chargeState?.connectors ?? {})
    .map(Number)
    .filter((id) => id !== AGGREGATE_CONNECTOR_ID)
    .sort((a, b) => a - b);
}

function buildChargerDevice(gladys, config, identity, chargeState) {
  const ids = gladys.externalIds(DEVICE_TYPE, identity);
  const observed = observedConnectorIds(chargeState);
  const connectorIds = observed.length > 0 ? observed : [DEFAULT_CONNECTOR_ID];
  return {
    name: `EV charger ${identity}`,
    external_id: ids.device,
    poll_frequency: toDevicePollFrequencyMs(config.poll_frequency),
    features: connectorIds.flatMap((connectorId) => buildConnectorFeatures(ids, connectorId)),
  };
}

export const charger = {
  key: DEVICE_TYPE,

  /** Prefix-based ownership check: one device per configured identity. */
  ownsDevice(gladys, externalId) {
    const prefix = gladys.externalIds(DEVICE_TYPE, '').device;
    return externalId.startsWith(prefix);
  },

  /**
   * Builds one device per configured charge point (`config.chargers`, see
   * ../chargers.js) - independent of whether the gateway has ever seen it
   * connect. When it HAS connected and reported connectors, those drive the
   * device's feature set; otherwise connector 1 is seeded by default (see
   * module doc comment). Returns an empty array only when nothing is
   * configured at all.
   *
   * `fetchState` defaults to the real gateway HTTP call; overridable so
   * tests can exercise this without a live gateway sub-container (see
   * test/devices/charger.test.js).
   */
  async buildDevices(gladys, config, fetchState = fetchGatewayState) {
    const identities = Object.keys(config.chargers ?? {});
    if (identities.length === 0) return [];

    let allChargers = {};
    try {
      ({ chargers: allChargers } = await fetchState());
    } catch (err) {
      logger.warn(
        'Gateway unreachable, offering configured charge points with their default connector only',
        err,
      );
    }

    return identities.map((identity) =>
      buildChargerDevice(gladys, config, identity, allChargers?.[identity]),
    );
  },

  async onPoll(gladys, config, device, fetchState = fetchGatewayState) {
    const identities = Object.keys(config.chargers ?? {});
    const identity = identities.find(
      (candidate) => gladys.externalIds(DEVICE_TYPE, candidate).device === device.external_id,
    );
    if (!identity) return; // not (or no longer) a configured charge point

    let allChargers;
    try {
      ({ chargers: allChargers } = await fetchState());
    } catch (err) {
      // The gateway sub-container can be briefly unreachable (still starting
      // up, mid-restart...) - not an error worth failing the poll command
      // over. Skip this cycle, the next poll will pick up fresh data.
      logger.warn(`Gateway unreachable, skipping poll for ${device.external_id}`, err);
      return;
    }

    const chargeState = allChargers?.[identity];
    if (!chargeState) return; // configured, but never seen connecting yet

    const ids = gladys.externalIds(DEVICE_TYPE, identity);
    const states = observedConnectorIds(chargeState).flatMap((connectorId) =>
      mapConnectorToStates(ids, connectorId, chargeState.connectors[connectorId]),
    );

    if (states.length > 0) {
      logger.info(`Poll OK: ${states.length} state(s) published for ${identity}`);
      await gladys.publishStates(states);
    }
  },
};
