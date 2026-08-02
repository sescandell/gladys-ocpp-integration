// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json` (today, just a static info section -
// there is no user-editable value there: poll_frequency was removed as a
// setting, see src/devices/charger.js's DEVICE_POLL_FREQUENCY_MS). The SDK
// still fetches this (`gladys.getConfig()`) and notifies changes through
// `gladys.onConfigUpdated()`, since the set of configured charge points
// lives in the same config object, just outside config_schema.
//
// The set of configured charge points (identity -> origin cloud URL) is NOT
// part of the schema either (see src/chargers.js) - it is folded into the
// normalized config here as `chargers` for convenience, since virtually
// every downstream module needs it.
//
// No "gateway_url" field here: the "gateway" sub-container is always reachable
// on a fixed internal URL (see src/gatewayClient.js), resolved through the
// private Docker network Gladys creates for this integration (DNS alias = the
// sub-container name declared in the manifest).
// -----------------------------------------------------------------------------

import { parseChargersStore } from './chargers.js';

/**
 * Merge the user config with the parsed charger store, folded in as
 * `chargers`.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...raw,
    chargers: parseChargersStore(raw),
  };
}
