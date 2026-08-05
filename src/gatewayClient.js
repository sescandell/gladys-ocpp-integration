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
 * Fetch the full gateway state: every charge point it currently knows about
 * (keyed by OCPP identity), whether configured (relayed to a real origin
 * cloud) or merely auto-detected (connected once, supervised locally - see
 * the gateway's "local mode", gateway/src/gateway.ts) - both live in the
 * same observed-state map.
 * @param {string} [baseUrl] override for tests; defaults to the fixed
 *   internal URL used in production (see module doc comment above).
 * @returns {Promise<{chargers: Record<string, object>}>}
 */
export async function fetchGatewayState(baseUrl = GATEWAY_INTERNAL_URL) {
  const res = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`gateway /api/state -> HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Subscribes to the gateway's change stream (`GET /api/events`, SSE - see
 * gateway/src/changeFeed.ts) and calls `onEvent` for every frame, until the
 * stream ends or `signal` aborts. Resolves when the stream ends; rejects if it
 * could not be opened. Reconnection is the caller's business (see index.js).
 *
 * Hand-rolled SSE parsing rather than a dependency: the format is two lines,
 * and `EventSource` only landed as a global in Node 22.3 - too new to rely on
 * for a container whose base image is not pinned by this repo.
 * @param {{baseUrl?: string, onEvent: (event: object) => void, signal?: AbortSignal}} options
 * @returns {Promise<void>}
 */
export async function streamGatewayEvents({ baseUrl = GATEWAY_INTERNAL_URL, onEvent, signal }) {
  // No timeout: an idle stream is the normal state of this connection (the
  // gateway sends a heartbeat comment so a dead peer still surfaces).
  const res = await fetch(`${baseUrl}/api/events`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`gateway /api/events -> HTTP ${res.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      // Comment-only frames (":ping") carry no data line and are skipped.
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .join('\n');
      if (data) {
        onEvent(JSON.parse(data));
      }
      separator = buffer.indexOf('\n\n');
    }
  }
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
