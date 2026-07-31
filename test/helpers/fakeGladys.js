// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishCameraImage             -> record calls so tests can assert them
//   - publishTransports              -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - getContainers / startContainer -> in-memory sub-container lifecycle,
//     seeded via `containers` option, mutated the same way the real supervisor
//     would (see gatewayClient.js's ensureGatewayRunning)
//   - getConfig                      -> returns `config` option
// This lets us test the pure "wiring" logic (discovery payloads, dispatch,
// sub-container lifecycle) without a running Gladys server or a real
// WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys(options = {}) {
  const published = [];
  const cameraImages = [];
  const transports = [];
  const connectionStatuses = [];
  const startContainerCalls = [];
  let containers = options.containers ?? [];

  return {
    published,
    cameraImages,
    transports,
    connectionStatuses,
    startContainerCalls,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async publishCameraImage(deviceExternalId, image) {
      cameraImages.push({ deviceExternalId, image });
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async getContainers() {
      return containers;
    },

    // Mirrors the real supervisor's contract (see gatewayClient.js's doc
    // comment): always ends up "running", with a host port assigned on first
    // start; kept simple (no simulated recreate-on-env-change) since the
    // guard against unnecessary calls is the integration's own responsibility,
    // not something to re-test against this fake.
    async startContainer(name, opts = {}) {
      startContainerCalls.push({ name, env: opts.env ?? {} });
      containers = containers.map((c) =>
        c.name === name
          ? {
              ...c,
              status: 'running',
              ports: c.ports?.map((p) => ({ ...p, host_port: p.host_port ?? 34000 })) ?? [],
            }
          : c,
      );
      return { success: true };
    },

    async getConfig() {
      return options.config ?? {};
    },
  };
}
