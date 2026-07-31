// -----------------------------------------------------------------------------
// Entry point of the Gladys OCPP integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/) AND
// drive the lifecycle of the "gateway" sub-container (see gateway/), which
// carries the real OCPP relay. No OCPP logic here: everything lives in the
// sub-container, only ever queried read-only via GET /api/state
// (src/gatewayClient.js).
//
// V1: READ-ONLY - no onSetValue registered. A handler absent for a command
// the SDK receives is automatically acked "not implemented" - no defensive
// code needed to enforce this scope.
//
// Environment variables provided by the Gladys supervisor to this container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from './src/devices/index.js';
import { ensureGatewayRunning } from './src/gatewayClient.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Last origin_cloud_url actually applied to the gateway sub-container - lets
// us distinguish "config re-saved without changing anything" (leave the
// sub-container alone) from "the URL actually changed" (restart needed).
// This matters because gladys.startContainer() restarts the sub-container on
// EVERY call, even when the env is unchanged (verified in the Gladys core
// source, externalIntegration.startSubContainer.js: container.restart() runs
// unconditionally) - calling it without this guard on every 'connected'
// event (which fires on every WebSocket reconnection to Gladys, unrelated to
// config changes) would drop the physical charge point's live OCPP session
// each time.
let lastAppliedOriginCloudUrl = null;

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered connector device(s)');
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
gladys.onPoll(async (device) => {
  const blueprint = findBlueprintByDevice(gladys, device);
  if (!blueprint || typeof blueprint.onPoll !== 'function') {
    logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
    return;
  }
  await blueprint.onPoll(gladys, config, device);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  await reconcileGateway();
  // Re-publish devices: poll_frequency and which connectors are currently
  // known may have changed (e.g. the gateway just (re)started).
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) Ensure the gateway sub-container is running BEFORE trying to read
    // its state, so a freshly-started gateway has at least been asked to
    // start (harmless when it's already running, see ensureGatewayRunning).
    await reconcileGateway();

    // 3) (Re)publish whatever connector devices are currently known.
    await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

/**
 * Ensures the gateway sub-container is in the right state given the current
 * config, and reflects the outcome in the connection status (visible on the
 * Configuration screen) - in particular the host port the physical charge
 * point must be pointed at.
 */
async function reconcileGateway() {
  if (!isConfigured(config)) {
    lastAppliedOriginCloudUrl = null;
    await gladys.setConnectionStatus(false, {
      en: 'Set the origin cloud URL to start the gateway.',
      fr: "Renseignez l'URL du cloud d'origine pour démarrer le relais.",
    });
    return;
  }

  try {
    const cloudUrlChanged =
      lastAppliedOriginCloudUrl !== null && lastAppliedOriginCloudUrl !== config.origin_cloud_url;
    const { hostPort } = await ensureGatewayRunning(
      gladys,
      config,
      /* forceRestart */ cloudUrlChanged,
    );
    lastAppliedOriginCloudUrl = config.origin_cloud_url;

    await gladys.setConnectionStatus(true, {
      en: hostPort
        ? `Gateway running. Point your charge point's OCPP server URL to port ${hostPort} of this Gladys host.`
        : 'Gateway running, host port not yet assigned.',
      fr: hostPort
        ? `Relais actif. Pointez l'URL du serveur OCPP de la borne vers le port ${hostPort} de cet hôte.`
        : 'Relais actif, port hôte pas encore assigné.',
    });
  } catch (err) {
    logger.error('Unable to start/verify the gateway sub-container', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Unable to start the gateway (see integration logs).',
        fr: "Impossible de démarrer le relais (voir les logs de l'intégration).",
      })
      .catch(() => {});
  }
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the OCPP gateway integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
