// -----------------------------------------------------------------------------
// Device type: EV CHARGER CONNECTOR.
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
// One Gladys device PER (CONFIGURED CHARGE POINT x PHYSICAL CONNECTOR),
// discovered dynamically: `config.chargers` (see ../chargers.js) lists every
// charge point identity the user has configured via the `add_charger`
// manifest action; for each one, OCPP connector id 0 is the aggregate charge
// point (never a device), ids 1..N are real physical connectors, reported by
// the charge point itself via StatusNotification. The set of devices this
// blueprint offers therefore grows as new charge points are configured and
// new connectors are observed - see buildDevices() below.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { fetchGatewayState } from '../gatewayClient.js';

const DEVICE_TYPE = 'ev-charger-connector';

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
// connector - always excluded from device discovery.
const AGGREGATE_CONNECTOR_ID = 0;

/**
 * Translates a gateway ConnectorState into Gladys feature states. Pure
 * function (no network call): what is unit-tested without a real SDK/gateway
 * connection, see test/devices/charger.test.js.
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} ids
 * @param {object|null} connector ConnectorState from the gateway (or null/undefined)
 * @returns {Array<{device_feature_external_id: string, state?: number, text?: string}>}
 */
export function mapConnectorToStates(ids, connector) {
  if (!connector) return [];

  const states = [];
  const push = (featureKey, value) => {
    if (value === null || value === undefined || Number.isNaN(value)) return;
    states.push({ device_feature_external_id: ids.feature(featureKey), state: value });
  };

  states.push({
    device_feature_external_id: ids.feature(FEATURE.STATUS),
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

function connectorPlatformId(identity, connectorId) {
  return `${identity}:${connectorId}`;
}

function buildConnectorDevice(gladys, config, identity, connectorId) {
  const ids = gladys.externalIds(DEVICE_TYPE, connectorPlatformId(identity, connectorId));
  return {
    name: `EV charger ${identity} - connector ${connectorId}`,
    external_id: ids.device,
    poll_frequency: config.poll_frequency,
    features: [
      {
        name: 'Status',
        external_id: ids.feature(FEATURE.STATUS),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Plugged',
        external_id: ids.feature(FEATURE.PLUGGED),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.PLUGGED,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Charging',
        external_id: ids.feature(FEATURE.CHARGING),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ON,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Charging power',
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_POWER,
        unit: DEVICE_FEATURE_UNITS.KILOWATT,
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Charging current',
        external_id: ids.feature(FEATURE.CURRENT),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_CURRENT,
        unit: DEVICE_FEATURE_UNITS.AMPERE,
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Voltage',
        external_id: ids.feature(FEATURE.VOLTAGE),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_VOLTAGE,
        unit: DEVICE_FEATURE_UNITS.VOLT,
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: 'Total energy',
        external_id: ids.feature(FEATURE.ENERGY),
        category: DEVICE_FEATURE_CATEGORIES.ELECTRICAL_VEHICLE_CHARGE,
        type: DEVICE_FEATURE_TYPES.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_ADDED_TOTAL,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

export const charger = {
  key: DEVICE_TYPE,

  /**
   * Prefix-based ownership check, since this blueprint no longer maps to a
   * single fixed device: it can offer any number of connector devices,
   * discovered at runtime.
   */
  ownsDevice(gladys, externalId) {
    const prefix = gladys.externalIds(DEVICE_TYPE, '').device;
    return externalId.startsWith(prefix);
  },

  /**
   * Builds one device per (configured charge point x physical connector
   * currently known to the gateway sub-container). Returns an empty array
   * (not an error) whenever there is nothing to offer yet: no charge point
   * configured, gateway unreachable, or a configured charge point hasn't
   * connected/reported any connector so far - all expected, transient
   * states.
   *
   * `fetchState` defaults to the real gateway HTTP call; overridable so
   * tests can exercise the connector-discovery logic without a live gateway
   * sub-container (see test/devices/charger.test.js).
   */
  async buildDevices(gladys, config, fetchState = fetchGatewayState) {
    const identities = Object.keys(config.chargers ?? {});
    if (identities.length === 0) return [];

    let allChargers;
    try {
      ({ chargers: allChargers } = await fetchState());
    } catch (err) {
      logger.warn('Gateway unreachable, cannot enumerate connectors yet', err);
      return [];
    }

    const devices = [];
    for (const identity of identities) {
      const chargeState = allChargers?.[identity];
      if (!chargeState) continue; // configured, but never seen connecting yet
      for (const connectorId of Object.keys(chargeState.connectors ?? {}).map(Number)) {
        if (connectorId === AGGREGATE_CONNECTOR_ID) continue;
        devices.push(buildConnectorDevice(gladys, config, identity, connectorId));
      }
    }
    return devices;
  },

  async onPoll(gladys, config, device, fetchState = fetchGatewayState) {
    let allChargers;
    try {
      ({ chargers: allChargers } = await fetchState());
    } catch (err) {
      // The gateway sub-container can be briefly unreachable (still starting
      // up, mid-restart...) - not an error worth failing the poll command
      // over, see buildDevices() above for the same reasoning. Skip this
      // cycle, the next poll will pick up fresh data.
      logger.warn(`Gateway unreachable, skipping poll for ${device.external_id}`, err);
      return;
    }

    for (const identity of Object.keys(config.chargers ?? {})) {
      const chargeState = allChargers?.[identity];
      if (!chargeState) continue;
      for (const connectorId of Object.keys(chargeState.connectors ?? {})) {
        const ids = gladys.externalIds(DEVICE_TYPE, connectorPlatformId(identity, connectorId));
        if (ids.device !== device.external_id) continue;
        const states = mapConnectorToStates(ids, chargeState.connectors[connectorId]);
        if (states.length > 0) {
          logger.info(
            `Poll OK: ${states.length} state(s) published for ${identity} connector ${connectorId}`,
          );
          await gladys.publishStates(states);
        }
        return;
      }
    }
    // No configured charge point currently reports this device's connector -
    // nothing to publish this cycle.
  },
};
