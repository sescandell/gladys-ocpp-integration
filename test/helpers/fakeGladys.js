// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration relies on:
//   - externalIds(type, platformId)  -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishCameraImage             -> record calls so tests can assert them
//   - publishTransports              -> record calls so tests can assert them
//   - publishDiscoveredDevices       -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - getContainers / startContainer -> in-memory sub-container lifecycle,
//     seeded via `containers` option, mutated the same way the real supervisor
//     would (see gatewayClient.js's ensureGatewayRunning)
//   - getConfig / setConfig          -> in-memory config, seeded via `config`
//   - onScanRequest / onPoll / onConfigUpdated / onAction / on / handleShutdown
//     -> registers the callback under the SAME invocation shape the real SDK
//     uses (verified against integration-sdk's index.d.ts), so calling a
//     captured handler directly in a test exercises the exact call shape
//     production code will receive - this is what caught index.js's onAction
//     destructuring bug (see test/index.test.js).
// This lets us test the pure "wiring" logic (discovery payloads, dispatch,
// sub-container lifecycle) without a running Gladys server or a real
// WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys(options = {}) {
  const published = [];
  const cameraImages = [];
  const transports = [];
  const discoveredDevices = [];
  const connectionStatuses = [];
  const startContainerCalls = [];
  const setConfigCalls = [];
  let containers = options.containers ?? [];
  let config = options.config ?? {};

  const handlers = {
    scanRequest: null,
    poll: null,
    configUpdated: null,
    actions: {},
    events: {},
    shutdown: null,
  };

  return {
    published,
    cameraImages,
    transports,
    discoveredDevices,
    connectionStatuses,
    startContainerCalls,
    setConfigCalls,
    handlers,

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

    async publishDiscoveredDevices(devices) {
      discoveredDevices.push(...devices);
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
      return config;
    },

    async setConfig(newConfig) {
      setConfigCalls.push(newConfig);
      config = { ...config, ...newConfig };
    },

    onScanRequest(callback) {
      handlers.scanRequest = callback;
    },

    onPoll(callback) {
      handlers.poll = callback;
    },

    onConfigUpdated(callback) {
      handlers.configUpdated = callback;
    },

    onAction(key, callback) {
      handlers.actions[key] = callback;
    },

    on(event, listener) {
      handlers.events[event] = listener;
    },

    handleShutdown(callback) {
      handlers.shutdown = callback;
    },
  };
}
