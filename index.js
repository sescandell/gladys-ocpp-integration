// -----------------------------------------------------------------------------
// Entry point of the Gladys OCPP integration.
//
// Role of this file: wire the SDK to the device catalog (src/devices/) AND
// drive the lifecycle of the "gateway" sub-container (see gateway/), which
// carries the real OCPP relay for every configured charge point. No OCPP
// logic here: everything lives in the sub-container, only ever queried
// read-only via GET /api/state, and driven via POST /api/chargers
// (src/gatewayClient.js).
//
// Any number of charge points can be configured, one at a time, through the
// `add_charger` manifest action (see gladys.onAction below) - not through the
// generated config form (Gladys's config_schema is a flat, fixed list of
// fields, it cannot represent "add as many charge points as you want"). The
// set of configured charge points lives in free internal config storage (see
// src/chargers.js), pushed LIVE to the gateway sub-container - no restart
// needed to pick up a newly configured (or removed) charge point.
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
import { normalizeConfig } from './src/config.js';
import { serializeChargersStore, upsertCharger, removeCharger } from './src/chargers.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from './src/devices/index.js';
import { ensureGatewayRunning, syncChargerMap, fetchGatewayState } from './src/gatewayClient.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated and after every
// add_charger action).
let config = normalizeConfig();

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

// --- Configuration updated by the user (poll_frequency only - the set of --
// --- charge points is managed by the add_charger action, see below) --------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  await reconcileGateway();
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
});

// --- Manifest action: configure (or remove) one charge point -----------------
// Fields: `identity` (required), `origin_cloud_url` (empty = remove). Runs
// independently of the config-form save flow, so it re-fetches the config
// fresh to merge against the latest saved charger set rather than risking a
// stale in-memory copy.
gladys.onAction('add_charger', async ({ fields }) => {
  const identity = String(fields.identity ?? '').trim();
  if (!identity) {
    throw new Error('Charge point identity is required.');
  }
  const originCloudUrl = String(fields.origin_cloud_url ?? '').trim();

  const freshConfig = normalizeConfig(await gladys.getConfig());
  let chargers = freshConfig.chargers;

  if (originCloudUrl === '') {
    chargers = removeCharger(chargers, identity);
  } else {
    try {
      const parsedUrl = new URL(originCloudUrl);
      if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
        throw new Error('not a ws(s):// URL');
      }
    } catch {
      throw new Error('The origin cloud URL must be a valid ws:// or wss:// URL.');
    }
    chargers = upsertCharger(chargers, identity, originCloudUrl);
  }

  await gladys.setConfig(serializeChargersStore(chargers));
  config = { ...freshConfig, chargers };

  await reconcileGateway();
  await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));

  return originCloudUrl === ''
    ? { en: `Charge point "${identity}" removed.`, fr: `Borne "${identity}" retirée.` }
    : { en: `Charge point "${identity}" configured.`, fr: `Borne "${identity}" configurée.` };
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // 1) Fetch the config filled in by the user.
    config = normalizeConfig(await gladys.getConfig());

    // 2) Ensure the gateway sub-container is running, push the current set of
    // configured charge points, and reflect it all in the connection status.
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
 * Ensures the gateway sub-container is running, pushes the current set of
 * configured charge points to it (a live, full replace - never a restart,
 * see gatewayClient.js), and reflects it all in the connection status
 * (visible on the Configuration screen): the assigned host port, how many
 * charge points are configured, and which identities have been seen
 * connecting without being configured yet ("pending" - surfaced so the user
 * can copy their identity into the `add_charger` action without having to
 * hunt for a serial number on a sticker).
 */
async function reconcileGateway() {
  try {
    const { hostPort } = await ensureGatewayRunning(gladys);
    await syncChargerMap(config.chargers);

    const configuredCount = Object.keys(config.chargers).length;
    let pendingIdentities = [];
    try {
      const state = await fetchGatewayState();
      pendingIdentities = state.pending.map((p) => p.identity);
    } catch (err) {
      logger.warn('Unable to fetch the gateway state for the status message', err);
    }

    const en = [
      hostPort
        ? `Relay running on port ${hostPort} of this Gladys host.`
        : 'Relay running, host port not yet assigned.',
      `${configuredCount} charge point(s) configured.`,
    ];
    const fr = [
      hostPort
        ? `Relais actif sur le port ${hostPort} de cet hôte.`
        : 'Relais actif, port hôte pas encore assigné.',
      `${configuredCount} borne(s) configurée(s).`,
    ];
    if (pendingIdentities.length > 0) {
      en.push(`Detected, awaiting configuration: ${pendingIdentities.join(', ')}.`);
      fr.push(`Détectée(s), en attente de configuration : ${pendingIdentities.join(', ')}.`);
    }

    await gladys.setConnectionStatus(true, { en: en.join(' '), fr: fr.join(' ') });
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
