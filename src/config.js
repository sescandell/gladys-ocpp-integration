// -----------------------------------------------------------------------------
// Integration configuration.
//
// Filled in by the user in Gladys, from the `config_schema` declared in
// `gladys-assistant-integration.json`. The SDK fetches it (`gladys.getConfig()`)
// and notifies every change through `gladys.onConfigUpdated()`.
//
// No "gateway_url" field here: the "gateway" sub-container is always reachable
// on a fixed internal URL (see src/gatewayClient.js), resolved through the
// private Docker network Gladys creates for this integration (DNS alias = the
// sub-container name declared in the manifest).
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  // OCPP server URL shown in the charger vendor's app - forwarded to the
  // gateway sub-container as a runtime env var (ORIGIN_CLOUD_URL), never
  // logged or displayed back.
  origin_cloud_url: '',
  // How often the gateway sub-container's state is polled, in seconds.
  poll_frequency: 30,
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    origin_cloud_url: String(raw.origin_cloud_url ?? DEFAULT_CONFIG.origin_cloud_url).trim(),
    poll_frequency: Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency),
  };
}

/**
 * Whether the user has filled in enough config to start the gateway
 * sub-container. Kept as its own predicate so the "don't start with an empty
 * URL" guard is unit-testable independently of the container-lifecycle code.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigured(config) {
  return config.origin_cloud_url !== '';
}
