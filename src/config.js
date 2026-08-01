// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// The set of configured charge points (identity -> origin cloud URL) is NOT
// part of the schema (see src/chargers.js) - it is folded into the
// normalized config here as `chargers` for convenience, since virtually
// every downstream module needs it alongside `poll_frequency`.
//
// No "gateway_url" field here: the "gateway" sub-container is always reachable
// on a fixed internal URL (see src/gatewayClient.js), resolved through the
// private Docker network Gladys creates for this integration (DNS alias = the
// sub-container name declared in the manifest).
// -----------------------------------------------------------------------------

import { parseChargersStore } from './chargers.js';

export const DEFAULT_CONFIG = {
  // How often each charge point's state is polled, in seconds.
  poll_frequency: 30,
};

/**
 * Merge the user config with the defaults, and fold in the parsed charger
 * store as `chargers`.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
    chargers: parseChargersStore(raw),
  };
}
