// -----------------------------------------------------------------------------
// External ids of a charge point and of its features. Kept apart from
// charger.js so the vendor modules (src/vendors/) can build and read them
// without importing the device definition that itself uses them.
// -----------------------------------------------------------------------------

export const DEVICE_TYPE = 'charger-station';

// OCPP 1.6 has no EVSE concept - only OCPP 2.x's StatusNotification/
// TransactionEvent carry an evseId alongside connectorId (one charge point
// can expose several EVSEs, each with its own connector(s)). This relay is
// 1.6-only today (see README's "Protocol scope"), but reserving this
// segment in the feature external_id NOW, before any real device exists in
// production, avoids a breaking external_id change (and the resulting loss
// of feature history) if 2.x support is ever added later - `1` matches
// OCPP 2.x's own convention for a charge point with a single EVSE (evseId 0
// is reserved for the aggregate charge point, same pattern as
// AGGREGATE_CONNECTOR_ID in charger.js).
const DEFAULT_EVSE_ID = 1;

/**
 * External id of one connector feature: `<device>:<featureKey>:<evse>:<connector>`.
 * Shared by the device definition, the published states, the dashboard
 * widget (src/widgets/charger.js), which binds tiles and charts to them, and
 * the vendor modules.
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} ids
 * @param {string} featureKey
 * @param {number} connectorId
 */
export function featureExternalId(ids, featureKey, connectorId) {
  return ids.feature(`${featureKey}:${DEFAULT_EVSE_ID}:${connectorId}`);
}

/**
 * Reverses `featureExternalId`: which feature and connector an external id of
 * this device designates. Null for anything else.
 * @param {import('@gladysassistant/integration-sdk').DeviceExternalIds} ids
 * @param {string} externalId
 * @returns {{featureKey: string, connectorId: number}|null}
 */
export function parseFeatureExternalId(ids, externalId) {
  const prefix = ids.feature('');
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return null;
  const [featureKey, evse, connector] = externalId.slice(prefix.length).split(':');
  const connectorId = Number(connector);
  if (!featureKey || Number(evse) !== DEFAULT_EVSE_ID || !Number.isInteger(connectorId)) {
    return null;
  }
  return { featureKey, connectorId };
}

/** External ids (device + features) of the charge point `identity`. */
export function chargerIds(gladys, identity) {
  return gladys.externalIds(DEVICE_TYPE, identity);
}
