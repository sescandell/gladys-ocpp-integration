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
// ONE Gladys device PER CHARGE POINT (not per connector), whether it's
// already configured (`config.chargers`) OR merely auto-detected by the
// gateway (connected once, no origin cloud set yet - see the gateway's
// "local mode", gateway/src/gateway.ts). A charge point shows up here the
// moment either is true - this matches the official discovery contract
// ("your integration never creates or deletes devices, it publishes the
// devices it discovers, and the user decides which ones to create" -
// gladysassistant.com/docs/dev/external-integrations) and mirrors how a
// cloud/account-based integration lists devices from its own registry,
// online or not. The `add_charger` action is only needed to attach an
// origin cloud URL (and switch the gateway into full relay mode for that
// charge point) - not to make it appear here at all.
//
// A charge point can have several physical connectors: each one becomes a
// small group of 6 features on the SAME device (`Connector <n> - <label>`),
// not a separate device - `buildDevices()` seeds connector 1 by default
// (the OCPP-conventional first, and only, connector on the vast majority of
// real hardware) so the device has something to show immediately, then
// grows the feature set as the gateway actually observes more connectors
// via StatusNotification. Growing the feature list of an ALREADY CREATED
// device surfaces as an "Update" button in Gladys (see
// `publishDiscoveredDevices`'s doc comment in the SDK) - the user stays in
// control of structural changes, same as day one.
//
// Each device also carries its configured origin cloud URL as a `param`
// (not a `feature`: it's config, not telemetry) - a plain read-only table
// Gladys renders on the device's card, in Discovery before creation AND in
// the device list after, silently kept in sync on every re-publish (no
// "Update" click needed for params, unlike a features structure change).
// This is the only place a charger's configured URL is visible in the UI.
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
  CONNECTOR_STATUS: 'connector-status',
  CHARGING_STATE: 'charging-state',
  POWER: 'power',
  CURRENT: 'current',
  VOLTAGE: 'voltage',
  ENERGY: 'energy',
};

// Hand-copied from Gladys core's server/utils/constants.js (>= 4.85.0): the
// SDK's constants mirror (0.10.0) predates the category and doesn't export
// it yet. Swap for DEVICE_FEATURE_CATEGORIES.CHARGING_STATION & co. once it
// resyncs.
const CHARGING_STATION_CATEGORY = 'charging-station';
const CHARGING_STATION_TYPES = {
  CONNECTOR_STATUS: 'connector-status',
  CHARGING_STATE: 'charging-state',
};
const CONNECTOR_STATUS = {
  AVAILABLE: 0,
  OCCUPIED: 1,
  RESERVED: 2,
  UNAVAILABLE: 3,
  FAULTED: 4,
};
const CHARGING_STATE = {
  CHARGING: 0,
  EV_CONNECTED: 1,
  PAUSED_BY_VEHICLE: 2,
  PAUSED_BY_CHARGER: 3,
  IDLE: 4,
  DISCHARGING: 5,
};

// Splits OCPP 1.6's single ChargePointStatus into Gladys's two features,
// following the mapping documented in core's constants.js.
// `chargingState: null` = no session in progress -> published as IDLE, since
// a Gladys feature holds its last value forever (a frozen "Charging" on an
// unplugged connector would be wrong). An unlisted status (including the
// gateway's "Unknown" placeholder) publishes neither feature.
const OCPP16_STATUS_MAP = {
  Available: { connectorStatus: CONNECTOR_STATUS.AVAILABLE, chargingState: null },
  Preparing: {
    connectorStatus: CONNECTOR_STATUS.OCCUPIED,
    chargingState: CHARGING_STATE.EV_CONNECTED,
  },
  Charging: { connectorStatus: CONNECTOR_STATUS.OCCUPIED, chargingState: CHARGING_STATE.CHARGING },
  SuspendedEVSE: {
    connectorStatus: CONNECTOR_STATUS.OCCUPIED,
    chargingState: CHARGING_STATE.PAUSED_BY_CHARGER,
  },
  SuspendedEV: {
    connectorStatus: CONNECTOR_STATUS.OCCUPIED,
    chargingState: CHARGING_STATE.PAUSED_BY_VEHICLE,
  },
  Finishing: { connectorStatus: CONNECTOR_STATUS.OCCUPIED, chargingState: CHARGING_STATE.IDLE },
  Reserved: { connectorStatus: CONNECTOR_STATUS.RESERVED, chargingState: null },
  Unavailable: { connectorStatus: CONNECTOR_STATUS.UNAVAILABLE, chargingState: null },
  Faulted: { connectorStatus: CONNECTOR_STATUS.FAULTED, chargingState: null },
};

// OCPP connector 0 represents the charge point as a whole, never a physical
// connector - always excluded from the feature set.
const AGGREGATE_CONNECTOR_ID = 0;

// Seeded when a charge point is configured but the gateway hasn't observed
// any connector yet - the OCPP-conventional first (and, for most real
// hardware, only) connector.
const DEFAULT_CONNECTOR_ID = 1;

// A discovered device's poll_frequency is NOT a free number: Gladys core
// rejects (and fails the ENTIRE publishDiscoveredDevices call, for every
// device in the batch) any value other than a few exact milliseconds,
// verified against server/utils/constants.js's DEVICE_POLL_FREQUENCIES
// (1000, 2000, 10000, 15000, 30000, 60000). Not user-configurable (Keep It
// Simple - the manifest declares no config_schema at all), so this is just a
// literal picked from that fixed set, Gladys's "every minute" tier.
const DEVICE_POLL_FREQUENCY_MS = 60_000;

/**
 * Translates one ConnectorState into Gladys feature states, scoped to
 * `connectorId` (a device carries one such group of features PER physical
 * connector). Pure function (no network call): what is unit-tested without
 * a real SDK/gateway connection, see test/devices/charger.test.js.
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} ids
 * @param {number} connectorId
 * @param {object|null} connector ConnectorState from the gateway (or null/undefined)
 * @returns {Array<{device_feature_external_id: string, state: number}>}
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

  const mapped = OCPP16_STATUS_MAP[connector.status];
  if (mapped) {
    push(FEATURE.CONNECTOR_STATUS, mapped.connectorStatus);
    push(FEATURE.CHARGING_STATE, mapped.chargingState ?? CHARGING_STATE.IDLE);
  }

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
      external_id: ids.feature(`${FEATURE.CONNECTOR_STATUS}:${connectorId}`),
      category: CHARGING_STATION_CATEGORY,
      type: CHARGING_STATION_TYPES.CONNECTOR_STATUS,
      // min/max are NOT NULL in t_device_feature and only enforced by the
      // device-creation insert (a missing one 422s on "Add to Gladys", not
      // at discovery). Bounds here are the enum's own range.
      min: 0,
      max: 4,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Charging state'),
      external_id: ids.feature(`${FEATURE.CHARGING_STATE}:${connectorId}`),
      category: CHARGING_STATION_CATEGORY,
      type: CHARGING_STATION_TYPES.CHARGING_STATE,
      min: 0,
      max: 5,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    // ENERGY_SENSOR, not ELECTRICAL_VEHICLE_CHARGE (a vehicle-side
    // category): only [energy-sensor, switch, teleinformation] categories
    // are offered by Gladys's energy monitoring page, so this is what lets
    // the totalizer be attached under the house meter (energy_parent_id).
    {
      name: label('Charging power'),
      external_id: ids.feature(`${FEATURE.POWER}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.POWER,
      unit: DEVICE_FEATURE_UNITS.KILOWATT,
      min: 0,
      max: 1000, // 1 MW headroom - generous even for ultra-fast DC charging
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Charging current'),
      external_id: ids.feature(`${FEATURE.CURRENT}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.CURRENT,
      unit: DEVICE_FEATURE_UNITS.AMPERE,
      min: 0,
      max: 1000,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Voltage'),
      external_id: ids.feature(`${FEATURE.VOLTAGE}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.VOLTAGE,
      unit: DEVICE_FEATURE_UNITS.VOLT,
      min: 0,
      max: 1000, // covers DC fast-charging voltages, well above any AC use
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: label('Total energy'),
      external_id: ids.feature(`${FEATURE.ENERGY}:${connectorId}`),
      category: DEVICE_FEATURE_CATEGORIES.ENERGY_SENSOR,
      type: DEVICE_FEATURE_TYPES.ENERGY_SENSOR.ENERGY,
      unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      min: 0,
      max: 1_000_000, // lifetime totalizer, never resets - needs real headroom
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

const NOT_YET_CONFIGURED = 'Not yet configured - run the "Add a charge point" action';

function buildChargerDevice(gladys, identity, originCloudUrl, chargeState) {
  const ids = gladys.externalIds(DEVICE_TYPE, identity);
  const observed = observedConnectorIds(chargeState);
  const connectorIds = observed.length > 0 ? observed : [DEFAULT_CONNECTOR_ID];
  return {
    name: `EV charger ${identity}`,
    external_id: ids.device,
    poll_frequency: DEVICE_POLL_FREQUENCY_MS,
    // Visible on the device's own card - Découverte before creation, then
    // Appareils after - both render a device's `params` as a plain
    // read-only table, silently kept in sync on every re-publish (no
    // "Update" click needed, unlike a `features` structure change). This is
    // the direct answer to "where can I see which cloud a charger is
    // relaying to": right on that charger, not a list somewhere else. Until
    // the `add_charger` action sets one, the charge point is still fully
    // supervised locally (see the gateway's "local mode") - just not yet
    // relayed anywhere.
    params: [{ name: 'Origin cloud URL', value: originCloudUrl ?? NOT_YET_CONFIGURED }],
    features: connectorIds.flatMap((connectorId) => buildConnectorFeatures(ids, connectorId)),
  };
}

/**
 * Every identity worth offering a device for: configured (`config.chargers`)
 * UNION auto-detected by the gateway (`allChargers`, the gateway's full
 * observed-state map - includes charge points connected in "local mode",
 * not just relayed ones). Neither set alone is enough: a charge point can be
 * configured but briefly unreachable (gateway restarting), or detected but
 * not yet configured at all.
 */
function knownIdentities(config, allChargers) {
  return [...new Set([...Object.keys(config.chargers ?? {}), ...Object.keys(allChargers ?? {})])];
}

/**
 * Reverses `gladys.externalIds(DEVICE_TYPE, identity).device` - i.e. maps
 * `ext:<selector>:ev-charger:<identity>` back to `<identity>`. Needed because
 * the `add_charger` action's charge point picker is a `select` with
 * `source: "devices"`, and Gladys populates such a select with each device's
 * `external_id` as the option VALUE (front's `loadDynamicOptions`) - so the
 * action handler receives an external_id where the rest of this code works in
 * OCPP identities.
 * @returns {string|null} the identity, or null if `externalId` isn't one of
 *   this blueprint's devices (the caller decides how to report that).
 */
export function identityFromDeviceExternalId(gladys, externalId) {
  const prefix = gladys.externalIds(DEVICE_TYPE, '').device;
  return externalId.startsWith(prefix) ? externalId.slice(prefix.length) : null;
}

export const charger = {
  key: DEVICE_TYPE,

  /** Prefix-based ownership check: one device per configured identity. */
  ownsDevice(gladys, externalId) {
    return identityFromDeviceExternalId(gladys, externalId) !== null;
  },

  /**
   * Builds one device per identity in `knownIdentities()` - configured
   * (`config.chargers`, see ../chargers.js) union auto-detected by the
   * gateway. When a charge point HAS connected and reported connectors,
   * those drive the device's feature set; otherwise connector 1 is seeded
   * by default (see module doc comment). Returns an empty array only when
   * nothing is configured AND nothing has ever been detected.
   *
   * `fetchState` defaults to the real gateway HTTP call; overridable so
   * tests can exercise this without a live gateway sub-container (see
   * test/devices/charger.test.js).
   */
  async buildDevices(gladys, config, fetchState = fetchGatewayState) {
    let allChargers = {};
    try {
      ({ chargers: allChargers } = await fetchState());
    } catch (err) {
      logger.warn('Gateway unreachable, offering configured charge points only', err);
    }

    const identities = knownIdentities(config, allChargers);
    if (identities.length === 0) return [];

    return identities.map((identity) =>
      buildChargerDevice(
        gladys,
        identity,
        config.chargers?.[identity] ?? null,
        allChargers?.[identity],
      ),
    );
  },

  async onPoll(gladys, config, device, fetchState = fetchGatewayState) {
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

    const identity = knownIdentities(config, allChargers).find(
      (candidate) => gladys.externalIds(DEVICE_TYPE, candidate).device === device.external_id,
    );
    if (!identity) return; // not (or no longer) a known charge point

    const chargeState = allChargers?.[identity];
    if (!chargeState) return; // known, but no observed connector state yet

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
