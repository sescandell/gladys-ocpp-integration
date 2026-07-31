// -----------------------------------------------------------------------------
// HTTP client towards the "gateway" sub-container (../gateway/, packaged via
// its own Dockerfile - a standalone project, no dependency on this code).
// Read-only: this process never talks to the physical charge point or the
// origin cloud directly, only GET /api/state.
//
// Fixed internal URL: the "gateway" sub-container is reachable by its
// declared manifest name (DNS alias on the private Docker network Gladys
// creates for this integration) on the CONTAINER port declared in the
// manifest (9080) - never the HOST port (which is dynamically assigned by
// Gladys for the LAN-facing OCPP port, 9321).
// -----------------------------------------------------------------------------

export const GATEWAY_INTERNAL_URL = 'http://gateway:9080';
export const GATEWAY_SUB_CONTAINER_NAME = 'gateway';
export const GATEWAY_OCPP_CONTAINER_PORT = 9321;

/**
 * Fetch the full state of every charge point currently known to the gateway
 * sub-container (keyed by OCPP identity).
 * @param {string} [baseUrl] override for tests; defaults to the fixed
 *   internal URL used in production (see module doc comment above).
 * @returns {Promise<Record<string, object>>}
 */
export async function fetchGatewayState(baseUrl = GATEWAY_INTERNAL_URL) {
  const res = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`gateway /api/state -> HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * V1 supervises a single charge point: pick the most recently seen entry if
 * the gateway's in-memory state ever holds more than one (e.g. leftover state
 * after the physical charger was swapped for another).
 * @param {Record<string, object>} allChargers
 * @returns {object|null}
 */
export function pickSupervisedCharger(allChargers) {
  const entries = Object.values(allChargers ?? {});
  if (entries.length === 0) return null;
  return entries.reduce((latest, charger) => {
    if (!latest) return charger;
    return (charger.lastSeenAt ?? '') > (latest.lastSeenAt ?? '') ? charger : latest;
  }, null);
}

/**
 * Ensures the gateway sub-container is running with the current config,
 * WITHOUT restarting it unnecessarily - `gladys.startContainer()` restarts
 * the sub-container on EVERY call, even when the runtime env is unchanged
 * (verified in the Gladys core source, externalIntegration.startSubContainer.js:
 * container.restart() runs unconditionally after the create-if-needed step).
 * Calling this without a guard on every 'connected'/'config-updated' event
 * (which fires on every WebSocket reconnection to Gladys, unrelated to
 * configuration changes) would drop the physical charge point's live OCPP
 * session each time. The sub-container is only (re)started here if it is not
 * already running, or if `forceRestart` says the origin cloud URL actually
 * changed since the last applied start.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {{origin_cloud_url: string}} config
 * @param {boolean} [forceRestart]
 * @returns {Promise<{started: boolean, hostPort: number|null}>}
 */
export async function ensureGatewayRunning(gladys, config, forceRestart = false) {
  const containers = await gladys.getContainers();
  const existing = containers.find((c) => c.name === GATEWAY_SUB_CONTAINER_NAME);
  const ocppPort = existing?.ports?.find((p) => p.container_port === GATEWAY_OCPP_CONTAINER_PORT);

  if (existing?.status === 'running' && !forceRestart) {
    return { started: false, hostPort: ocppPort?.host_port ?? null };
  }

  await gladys.startContainer(GATEWAY_SUB_CONTAINER_NAME, {
    env: { ORIGIN_CLOUD_URL: config.origin_cloud_url },
  });

  const updated = await gladys.getContainers();
  const started = updated.find((c) => c.name === GATEWAY_SUB_CONTAINER_NAME);
  const startedPort = started?.ports?.find((p) => p.container_port === GATEWAY_OCPP_CONTAINER_PORT);
  return { started: true, hostPort: startedPort?.host_port ?? null };
}
