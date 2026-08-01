// -----------------------------------------------------------------------------
// HTTP client towards the "gateway" sub-container (../gateway/, packaged via
// its own Dockerfile - a standalone project, no dependency on this code).
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
 * Fetch the full gateway state: every configured charge point currently
 * known (keyed by OCPP identity), plus the identities seen connecting
 * without being configured yet ("pending" - see the gateway's
 * ChargerRegistry).
 * @param {string} [baseUrl] override for tests; defaults to the fixed
 *   internal URL used in production (see module doc comment above).
 * @returns {Promise<{chargers: Record<string, object>, pending: Array<{identity: string, firstSeenAt: string, lastSeenAt: string}>}>}
 */
export async function fetchGatewayState(baseUrl = GATEWAY_INTERNAL_URL) {
  const res = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`gateway /api/state -> HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Pushes the full, current set of configured charge points (identity ->
 * origin cloud URL) to the gateway sub-container - a live, full replace, no
 * container restart involved. Safe to call anytime the gateway is running:
 * unlike `startContainer`, this never interrupts an already-relaying charge
 * point's session (see `ensureGatewayRunning`'s doc comment for why that
 * distinction matters).
 * @param {Record<string, string>} chargers identity -> origin cloud URL
 * @param {string} [baseUrl] override for tests
 * @returns {Promise<{success: boolean, configuredCount: number}>}
 */
export async function syncChargerMap(chargers, baseUrl = GATEWAY_INTERNAL_URL) {
  const res = await fetch(`${baseUrl}/api/chargers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chargers }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`gateway /api/chargers -> HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Ensures the gateway sub-container is running, and reports its assigned
 * host port.
 *
 * The manifest declares the sub-container `start: "auto"`: Gladys's
 * supervisor creates and starts it BEFORE this main container even boots,
 * and independently restarts it (with backoff) if it ever crashes - so this
 * is a defensive fallback for the unlikely case it isn't running yet the
 * first time this is checked, not the primary way it gets started.
 *
 * Deliberately does NOT take the set of configured charge points as a
 * parameter, and never restarts an already-running container: which charge
 * points are configured is pushed live via `syncChargerMap()` instead (see
 * `POST /api/chargers`), so a config change never needs to interrupt every
 * OTHER charge point's live OCPP session the way a container restart would
 * (verified in the Gladys core source,
 * externalIntegration.startSubContainer.js: `container.restart()` runs
 * unconditionally on every `startContainer` call, even with an unchanged env).
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @returns {Promise<{started: boolean, hostPort: number|null}>}
 */
export async function ensureGatewayRunning(gladys) {
  const containers = await gladys.getContainers();
  const existing = containers.find((c) => c.name === GATEWAY_SUB_CONTAINER_NAME);
  const ocppPort = existing?.ports?.find((p) => p.container_port === GATEWAY_OCPP_CONTAINER_PORT);

  if (existing?.status === 'running') {
    return { started: false, hostPort: ocppPort?.host_port ?? null };
  }

  await gladys.startContainer(GATEWAY_SUB_CONTAINER_NAME);

  const updated = await gladys.getContainers();
  const started = updated.find((c) => c.name === GATEWAY_SUB_CONTAINER_NAME);
  const startedPort = started?.ports?.find((p) => p.container_port === GATEWAY_OCPP_CONTAINER_PORT);
  return { started: true, hostPort: startedPort?.host_port ?? null };
}
