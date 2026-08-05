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
// A charge point does NOT need to be configured to show up: the gateway
// accepts any connection and supervises it locally (see gateway/src/
// gateway.ts's "local mode"), so it appears in Discovery the moment it
// connects. The `add_charger` manifest action (see registerHandlers's
// gladys.onAction below) is only needed to attach an origin cloud URL and
// switch that one charge point into full relay mode - not through the
// generated config form (Gladys's config_schema is a flat, fixed list of
// fields, it cannot represent "add as many charge points as you want"). The
// set of configured charge points lives in free internal config storage
// (see src/chargers.js), pushed LIVE to the gateway sub-container - no
// restart needed to pick up a newly configured (or removed) charge point.
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
import {
  buildDiscoveredDevices,
  findBlueprintByDevice,
  gatewayStateReader,
} from './src/devices/index.js';
import {
  identityFromDeviceExternalId,
  chargerStates,
  observedConnectorIds,
} from './src/devices/charger.js';
import { createStatePublisher } from './src/stateSync.js';
import {
  ensureGatewayRunning,
  syncChargerMap,
  streamGatewayEvents,
  GATEWAY_SUB_CONTAINER_NAME,
} from './src/gatewayClient.js';

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
 * @param {{gatewayBaseUrl?: string, gatewayRetry?: {attempts?: number, delayMs?: number}, discoveryRefreshIntervalMs?: number}} [options]
 *   `gatewayBaseUrl` overrides the gateway sub-container's fixed internal
 *   URL - test-only (see test/index.test.js): hitting the real one from a
 *   dev machine takes several real seconds to fail (DNS), against a local
 *   fake server it's instant. Production never passes this, so it always
 *   uses the real internal DNS alias (see gatewayClient.js). `gatewayRetry`
 *   overrides the retry schedule around the gateway's own HTTP API (see
 *   `withGatewayRetries` below) - test-only, to keep retry tests fast.
 *   `discoveryRefreshIntervalMs` <= 0 disables the periodic republish, and
 *   `eventStreamEnabled: false` the subscription to the gateway's change
 *   stream - both test-only, production wants them on.
 * @returns {{refreshDiscovery: () => Promise<void>, handleGatewayChange: (event: object) => Promise<void>}}
 */
export function registerHandlers(
  gladys,
  {
    gatewayBaseUrl,
    gatewayRetry = {},
    discoveryRefreshIntervalMs = 30_000,
    eventStreamEnabled = true,
  } = {},
) {
  const gatewayRetryAttempts = gatewayRetry.attempts ?? 5;
  const gatewayRetryDelayMs = gatewayRetry.delayMs ?? 500;
  const fetchState = gatewayStateReader(gatewayBaseUrl);

  // Current configuration (hot-reloaded via onConfigUpdated and after every
  // add_charger action).
  let config = normalizeConfig();

  // Signature of the last successfully published device list, so the periodic
  // refresh below only republishes on an actual change.
  let lastPublishedSignature = null;
  let discoveryTimer = null;
  let eventStreamAbort = null;
  let eventStreamRunning = false;
  let stopped = false;
  /** identity -> connector ids last reflected in Discovery. */
  const publishedShapes = new Map();

  const statePublisher = createStatePublisher({
    publishStates: (states) => gladys.publishStates(states),
    logger,
  });

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

  /** Identifies a published device list: which devices, with which features. */
  function discoverySignature(devices) {
    return devices
      .map(
        (device) => `${device.external_id}[${(device.features ?? []).map((f) => f.external_id)}]`,
      )
      .sort()
      .join('|');
  }

  /**
   * Builds and publishes the current device list. `onlyIfChanged` skips the
   * call when nothing moved since the last publish - used by the periodic
   * refresh, which would otherwise push a websocket update to every open
   * front every tick.
   */
  async function publishDevices({ onlyIfChanged = false } = {}) {
    const devices = await buildDiscoveredDevices(gladys, config, fetchState);
    const signature = discoverySignature(devices);
    if (onlyIfChanged && signature === lastPublishedSignature) {
      return;
    }
    await gladys.publishDiscoveredDevices(devices);
    lastPublishedSignature = signature;
    logger.info(`Published ${devices.length} discovered device(s)`);
  }

  /**
   * One change pushed by the gateway (see gateway/src/changeFeed.ts): publish
   * the charge point's states, and - when it brings a charge point or a
   * connector never published before - refresh Discovery too, so hardware
   * plugged in right now appears within seconds rather than at the next tick.
   *
   * The event carries the charger's full state, so the common case (a meter
   * value on a known connector) costs no call back to the gateway at all:
   * `publishedShapes` is what keeps the Discovery refresh off that path.
   */
  async function handleGatewayChange({ identity, charger }) {
    if (!identity || !charger) return;
    const shape = observedConnectorIds(charger).join(',');
    if (publishedShapes.get(identity) !== shape) {
      publishedShapes.set(identity, shape);
      await publishDevices({ onlyIfChanged: true });
    }
    statePublisher.enqueue(chargerStates(gladys, identity, charger));
  }

  /**
   * Keeps the change stream up for as long as the integration runs. The stream
   * ends on its own whenever the gateway sub-container restarts (an update, a
   * crash, the reset_all action), so reconnecting is the normal path, not an
   * error path - hence the plain warn and the fixed retry delay.
   */
  async function runEventStream() {
    if (!eventStreamEnabled || eventStreamRunning) return;
    eventStreamRunning = true;
    try {
      while (!stopped) {
        const controller = new AbortController();
        eventStreamAbort = controller;
        try {
          await streamGatewayEvents({
            baseUrl: gatewayBaseUrl,
            signal: controller.signal,
            onEvent: (event) => {
              handleGatewayChange(event).catch((err) => {
                logger.warn('Failed to handle a gateway change event', err);
              });
            },
          });
        } catch (err) {
          if (stopped) return;
          logger.warn('Gateway event stream lost, reconnecting', err);
        }
        if (stopped) return;
        await new Promise((resolve) => setTimeout(resolve, gatewayRetryDelayMs));
      }
    } finally {
      eventStreamRunning = false;
    }
  }

  // A charge point can connect at any time and the gateway has no way to push
  // that back here (it only answers GET /api/state), so without this the
  // device would stay invisible until the user happened to hit Rescan - or
  // forever, since nothing else republishes on its own. Observed for real:
  // after an integration update, the gateway restarts with an empty in-memory
  // store and the charge point reconnects on its own backoff, always after
  // the reconnection republish has already run.
  function startDiscoveryRefresh() {
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
    if (discoveryRefreshIntervalMs <= 0) {
      return;
    }
    discoveryTimer = setInterval(() => {
      publishDevices({ onlyIfChanged: true }).catch((err) => {
        logger.warn('Periodic discovery refresh failed', err);
      });
    }, discoveryRefreshIntervalMs);
    // Never hold the process open on this alone.
    discoveryTimer.unref?.();
  }

  /**
   * Ensures the gateway sub-container is running, pushes the current set of
   * configured charge points to it (a live, full replace - never a restart,
   * see gatewayClient.js), and reflects it all in the connection status
   * (visible on the Supervision screen only - Gladys only renders it on
   * Configuration for integrations with an `oauth2` config field, which
   * this manifest doesn't have): the ready-to-use OCPP URL to point charge
   * points at (host part templated - we only know the assigned port, not
   * this Gladys host's own LAN address) and how many charge points are
   * configured. Which charge points exist at all - configured or merely
   * auto-detected by the gateway's "local mode" - is NOT summarized here:
   * it's shown directly in Discovery (see src/devices/charger.js), and each
   * one's configured origin cloud URL on its own device card (`params`) -
   * both a better fit than this single-line, ops-flavored status caption.
   */
  async function reconcileGateway() {
    try {
      const { hostPort } = await ensureGatewayRunning(gladys);
      await withGatewayRetries(() => syncChargerMap(config.chargers, gatewayBaseUrl));

      const configuredCount = Object.keys(config.chargers).length;
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
    await publishDevices();
  });

  // --- Polling: Gladys asks to refresh a device --------------------------------
  gladys.onPoll(async (device) => {
    const blueprint = findBlueprintByDevice(gladys, device);
    if (!blueprint || typeof blueprint.onPoll !== 'function') {
      logger.debug(`onPoll ignored (no polling) for ${device.external_id}`);
      return;
    }
    await blueprint.onPoll(gladys, config, device, fetchState);
  });

  // --- Configuration updated (the manifest declares no config_schema at ------
  // --- all - there is no generated form and nothing for the user to fill -----
  // --- in; the set of charge points is managed entirely through the ----------
  // --- add_charger action below, whose own setConfig lands here) -------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    await reconcileGateway();
    await publishDevices();
  });

  // --- Manifest action: add (or remove) one charge point -----------------------
  // Fields: `device` (required), `origin_cloud_url` (empty = remove). Runs
  // independently of the config-form save flow, so it re-fetches the config
  // fresh to merge against the latest saved charger set rather than risking a
  // stale in-memory copy.
  //
  // `device` is a `select` with `source: "devices"`: Gladys itself populates
  // the dropdown, and the value it hands back is the device's EXTERNAL_ID,
  // not the OCPP identity everything else here works in - hence the
  // translation below. This spares the user retyping an exact identity
  // string, at the cost of an ordering requirement Gladys imposes: such a
  // select only lists devices ALREADY ADDED to Gladys (the core endpoint
  // behind it reads t_device; merely-discovered devices live in an in-memory
  // map it never queries), so a charge point must be created from Discovery
  // before it can be given an origin cloud URL here.
  gladys.onAction('add_charger', async (fields) => {
    const deviceExternalId = String(fields.device ?? '').trim();
    if (!deviceExternalId) {
      throw new Error('Select a charge point.');
    }
    const identity = identityFromDeviceExternalId(gladys, deviceExternalId);
    if (!identity) {
      throw new Error(`Not one of this integration's charge points: ${deviceExternalId}`);
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
    await publishDevices();

    return originCloudUrl === ''
      ? {
          en: `Charge point "${identity}" detached from its origin cloud - back to local-only supervision.`,
          fr: `Borne "${identity}" détachée de son cloud d'origine - retour en supervision locale uniquement.`,
        }
      : {
          en: `Charge point "${identity}" configured. If it's already connected, it will automatically reconnect within a few seconds and start relaying to its origin cloud - the configured URL is shown on its device card.`,
          fr: `Borne "${identity}" configurée. Si elle est déjà connectée, elle se reconnectera automatiquement dans les secondes qui suivent et commencera à être relayée vers son cloud d'origine - l'URL configurée est affichée sur sa fiche appareil.`,
        };
  });

  // --- Manifest action: debug reset -------------------------------------------
  // Clears every configured charge point and restarts the "gateway" sub-
  // container, which wipes ALL of its in-memory state at once (StateStore,
  // ChargerRegistry, localClients - see gateway/src/gateway.ts) - the only
  // way to drop a live RELAY-mode connection too, since (unlike local-mode
  // ones) those aren't tracked in any identity-keyed map the state API could
  // force-close individually. Every connected charge point, configured or
  // not, has to reconnect afterwards - it then shows up again exactly as it
  // would on first contact (local mode, or relay mode if still configured
  // once this action's own config wipe below has been undone by re-running
  // "Add a charge point"). This can NOT remove devices already created in
  // Gladys: the SDK exposes no device-deletion call (see `onDeviceDeleted`,
  // the other direction) - remove those manually from the device list.
  gladys.onAction('reset_all', async (fields) => {
    if (String(fields.confirm ?? '').trim() !== 'RESET') {
      throw new Error('Type RESET (uppercase) in the confirmation field to proceed.');
    }

    await gladys.setConfig(serializeChargersStore({}));
    config = { ...normalizeConfig(await gladys.getConfig()), chargers: {} };

    await gladys.restartContainer(GATEWAY_SUB_CONTAINER_NAME);
    await reconcileGateway();
    await publishDevices();

    return {
      en: 'Gateway state cleared and every charge point unconfigured. Connected charge points will reconnect automatically within a few seconds and reappear in Discovery. Devices already added to Gladys were NOT removed - delete those manually if you no longer want them.',
      fr: "État du relais réinitialisé et toutes les bornes déconfigurées. Les bornes connectées se reconnecteront automatiquement dans les secondes qui suivent et réapparaîtront dans Découverte. Les appareils déjà ajoutés à Gladys n'ont PAS été supprimés - retirez-les manuellement si vous n'en voulez plus.",
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
      await publishDevices();
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    } finally {
      // Even if the steps above failed: the gateway may well come back on its
      // own, and these are what pick it up.
      startDiscoveryRefresh();
      runEventStream().catch((err) => logger.error('Gateway event stream stopped', err));
    }
  });

  // --- Graceful shutdown -------------------------------------------------------
  gladys.handleShutdown((signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopped = true;
    if (discoveryTimer) {
      clearInterval(discoveryTimer);
      discoveryTimer = null;
    }
    eventStreamAbort?.abort();
    statePublisher.stop();
  });

  // Lets a test drive one tick, or one gateway event, without the real timer
  // or a live stream.
  return {
    refreshDiscovery: () => publishDevices({ onlyIfChanged: true }),
    handleGatewayChange,
  };
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
