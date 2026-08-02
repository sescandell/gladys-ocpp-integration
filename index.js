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
// `add_charger` manifest action (see registerHandlers's gladys.onAction
// below) - not through the generated config form (Gladys's config_schema is
// a flat, fixed list of fields, it cannot represent "add as many charge
// points as you want"). The set of configured charge points lives in free
// internal config storage (see src/chargers.js), pushed LIVE to the gateway
// sub-container - no restart needed to pick up a newly configured (or
// removed) charge point.
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

import { fileURLToPath } from 'node:url';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './src/config.js';
import { serializeChargersStore, upsertCharger, removeCharger } from './src/chargers.js';
import { buildDiscoveredDevices, findBlueprintByDevice } from './src/devices/index.js';
import { ensureGatewayRunning, syncChargerMap, fetchGatewayState } from './src/gatewayClient.js';

/**
 * Wires every SDK handler onto `gladys` - deliberately does NOT call
 * `gladys.connect()` (that's main()'s job, see bottom of this file), so this
 * stays free of the real network side effect and can be exercised directly
 * in tests against a fake SDK object (see test/index.test.js), exactly like
 * `createGatewayServer()` in gateway/src/gateway.ts does for the same
 * reason. This is also what caught (and now guards against) a real bug: the
 * SDK invokes an `onAction` callback as `callback(fields)`, not
 * `callback({ fields })` - a wrong destructure here crashed on
 * `fields.identity` the moment the action ran for real.
 * @param {import('@gladysassistant/integration-sdk').GladysIntegration} gladys
 * @param {{gatewayBaseUrl?: string, gatewayRetry?: {attempts?: number, delayMs?: number}}} [options]
 *   `gatewayBaseUrl` overrides the gateway sub-container's fixed internal
 *   URL - test-only (see test/index.test.js): hitting the real one from a
 *   dev machine takes several real seconds to fail (DNS), against a local
 *   fake server it's instant. Production never passes this, so it always
 *   uses the real internal DNS alias (see gatewayClient.js). `gatewayRetry`
 *   overrides the retry schedule around the gateway's own HTTP API (see
 *   `withGatewayRetries` below) - test-only, to keep retry tests fast.
 */
export function registerHandlers(gladys, { gatewayBaseUrl, gatewayRetry = {} } = {}) {
  const gatewayRetryAttempts = gatewayRetry.attempts ?? 5;
  const gatewayRetryDelayMs = gatewayRetry.delayMs ?? 500;

  // Current configuration (hot-reloaded via onConfigUpdated and after every
  // add_charger action).
  let config = normalizeConfig();

  /**
   * A few short retries around a call that reaches the gateway sub-
   * container's OWN HTTP API (unlike `ensureGatewayRunning`, which only
   * talks to the Gladys host API about container status). Real-world
   * observation: even with `start: "auto"` (the supervisor starts the
   * sub-container before this one boots), Docker reporting it "running"
   * does not mean its Node process has finished starting up and bound its
   * HTTP server yet - a benign race that showed up as an immediate
   * ECONNREFUSED right after connecting to Gladys, and would otherwise
   * leave the connection status stuck on "unable to start the gateway"
   * until something else happened to re-run reconcileGateway (a config
   * save, an add_charger action, a reconnect) - nothing self-heals it on
   * its own.
   */
  async function withGatewayRetries(fn) {
    let lastErr;
    for (let attempt = 0; attempt < gatewayRetryAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < gatewayRetryAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, gatewayRetryDelayMs));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Ensures the gateway sub-container is running, pushes the current set of
   * configured charge points to it (a live, full replace - never a restart,
   * see gatewayClient.js), and reflects it all in the connection status
   * (visible on the Supervision screen only - Gladys only renders it on
   * Configuration for integrations with an `oauth2` config field, which
   * this manifest doesn't have): the ready-to-use OCPP URL to point charge
   * points at (host part templated - we only know the assigned port, not
   * this Gladys host's own LAN address), how many charge points are
   * configured, and which identities have been seen connecting without
   * being configured yet ("pending" - a typo-diagnostic fallback, see
   * docs/en.md - not the intended discovery flow). Each individual charge
   * point's configured origin cloud URL is NOT listed here - it's shown on
   * that charge point's own device card instead (Discovery, then the
   * device list - see src/devices/charger.js's `params`), which is a
   * better fit than this single-line, ops-flavored status caption.
   */
  async function reconcileGateway() {
    try {
      const { hostPort } = await ensureGatewayRunning(gladys);
      await withGatewayRetries(() => syncChargerMap(config.chargers, gatewayBaseUrl));

      const configuredCount = Object.keys(config.chargers).length;
      let pendingIdentities = [];
      try {
        const state = await fetchGatewayState(gatewayBaseUrl);
        pendingIdentities = state.pending.map((p) => p.identity);
      } catch (err) {
        logger.warn('Unable to fetch the gateway state for the status message', err);
      }

      const en = [
        hostPort
          ? `OCPP URL: ws://<this Gladys host's LAN address>:${hostPort}/ - enter this in each charge point's vendor app.`
          : 'Relay running, host port not yet assigned.',
        `${configuredCount} charge point(s) configured.`,
      ];
      const fr = [
        hostPort
          ? `URL OCPP : ws://<adresse LAN de cet hôte Gladys>:${hostPort}/ - à saisir dans l'application de chaque borne.`
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

  // --- Discovery: Gladys asks for the list of devices -------------------------
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

  // --- Configuration updated by the user (the config form is just a static --
  // --- info section today - no user-editable value; the set of charge -------
  // --- points is managed entirely through the add_charger action, below) ----
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    await reconcileGateway();
    await gladys.publishDiscoveredDevices(await buildDiscoveredDevices(gladys, config));
  });

  // --- Manifest action: add (or remove) one charge point -----------------------
  // Fields: `identity` (required), `origin_cloud_url` (empty = remove). Runs
  // independently of the config-form save flow, so it re-fetches the config
  // fresh to merge against the latest saved charger set rather than risking a
  // stale in-memory copy.
  gladys.onAction('add_charger', async (fields) => {
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
      : {
          en: `Charge point "${identity}" configured. Check the Discovery tab to add it as a device - its origin cloud URL is shown there.`,
          fr: `Borne "${identity}" configurée. Consultez l'onglet Découverte pour l'ajouter comme appareil - son URL de cloud d'origine y est affichée.`,
        };
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

  // --- Graceful shutdown -------------------------------------------------------
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const gladys = new GladysIntegration();
  registerHandlers(gladys);

  logger.info('Starting the OCPP gateway integration...');
  gladys.connect().catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
}
