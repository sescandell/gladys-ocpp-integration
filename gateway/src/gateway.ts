/**
 * OCPP 1.6 relay (charge points <-> each one's own configured origin cloud),
 * the companion sub-container of the Gladys OCPP integration.
 *
 * This file has no idea it may run under Gladys supervision: it only speaks
 * OCPP + a tiny internal HTTP API (see `stateApi.ts`), nothing specific to
 * the Gladys SDK lives here - that lives in the main integration container
 * (`../index.js`), which polls this process over its private-network DNS
 * alias (see `../src/gatewayClient.js`) and pushes the live set of
 * configured charge points via `POST /api/chargers` (see `chargerRegistry.ts`).
 *
 * Any number of charge points share this single port. Each one is routed to
 * its own origin cloud independently, resolved by its real OCPP identity (the
 * one it announces on connection) against the live registry - never a
 * position/index in the URL, which would depend on unverifiable per-vendor
 * firmware behavior.
 *
 * TWO MODES per charge point, decided at connection time:
 *
 * - RELAY MODE (identity has a configured origin cloud URL): a CSMS-side
 *   server facing the charge point, and an OCPP client facing its origin
 *   cloud (the "primary"). The business logic is an OBSERVATION of the
 *   primary's REAL response, never an autonomous decision: the
 *   transactionId recorded in the internal state is the one the primary
 *   assigned, never invented locally - otherwise the history would not
 *   match what the charge point/cloud actually use for a later
 *   StopTransaction. Response asymmetry: for a CALL initiated by the
 *   charge point, only the primary's response matters to the charge point.
 *
 * - LOCAL MODE (identity not configured yet - see `localMode.ts`): the
 *   gateway itself acts as a permissive, "everything is fine" CSMS -
 *   accepts the connection, answers every OCPP call with a synthesized
 *   generic-success response, and still runs it through `observe()` so
 *   real telemetry (status, meter values) lands in the SAME `StateStore` as
 *   relay mode. Nothing is forwarded anywhere: there is no origin cloud
 *   yet. This makes a charge point auto-detected and immediately
 *   supervisable the moment it connects - no more "declare its identity
 *   before pointing it at the relay" ordering requirement. The moment the
 *   user configures an origin_cloud_url for that identity (`add_charger`
 *   action -> `POST /api/chargers`, see `stateApi.ts`), THAT ONE charge
 *   point's live connection is force-closed so it reconnects and this time
 *   resolves to relay mode - `localClients` (below) is what makes that
 *   possible: `ocpp-rpc`'s `RPCServer` exposes no identity-keyed lookup of
 *   its own connected clients.
 *
 *   Known limitation: a transaction STARTED while in local mode gets a
 *   locally-invented transactionId (see `localMode.ts`) the real origin
 *   cloud never issued. `stateApi.ts` clears our own stale state on the
 *   forced reconnect (`store.reset()`), but the physical charge point may
 *   keep referencing that fake id after reconnecting (OCPP transactions
 *   typically survive a WebSocket reconnect in real firmware) - a real,
 *   accepted correctness gap for what should be a rare overlap (actively
 *   charging exactly when first configuring that charge point), not worth
 *   the complexity of blocking reconnects until a transaction ends.
 *
 * Multi-charge-point isolation either way: one connection (plus, in relay
 * mode, one primary client) per identity, closed over its own connection
 * closure, no shared state. No strictMode (faithful passthrough, including
 * vendor-specific messages not covered by the OCPP schema embedded in
 * ocpp-rpc).
 */

import { fileURLToPath } from 'node:url';
import { RPCServer, RPCClient } from 'ocpp-rpc';
import type { IHandlersOption } from 'ocpp-rpc';
import { StateStore } from './state.ts';
import { ChargerRegistry } from './chargerRegistry.ts';
import { observe } from './observe.ts';
import { createStateApiServer, type LocalClient } from './stateApi.ts';
import { createChangeFeed } from './changeFeed.ts';
import { formatExchangeLog } from './exchangeLog.ts';
import { buildPrimaryConnectionOptions } from './originConnection.ts';
import { synthesizeLocalResponse } from './localMode.ts';

export interface GatewayOptions {
  protocols?: string[];
}

const DEFAULT_PROTOCOLS = ['ocpp1.6'];

export const store = new StateStore();
export const registry = new ChargerRegistry();
/** Currently-connected charge points in LOCAL MODE only - see header comment. */
export const localClients: Map<string, LocalClient> = new Map();
/** Pushes observed changes to the main container - see changeFeed.ts. */
export const changeFeed = createChangeFeed(store);

export function createGatewayServer(options: GatewayOptions = {}) {
  const protocols = options.protocols ?? DEFAULT_PROTOCOLS;

  const server = new RPCServer({
    protocols,
    // No strictMode: faithful passthrough to the primary, see header comment.
  });

  server.auth((accept: (session?: Record<string, unknown>) => void) => {
    accept();
  });

  server.on('client', (client: any) => {
    const identity = client.identity as string;
    const state = store.get(identity);
    // A charge point connecting is itself news: this is what makes it show up
    // in Discovery within seconds rather than at the next refresh.
    changeFeed.notify(identity);

    const originCloudUrl = registry.resolve(identity);
    if (originCloudUrl === undefined) {
      // LOCAL MODE: no origin cloud configured yet - see header comment.
      // Permissive, generic-success responses, real telemetry still
      // observed into `state` (the same StateStore relay mode uses).
      console.log(`[connect] ${identity} - local mode (no origin cloud configured yet)`);
      localClients.set(identity, client);

      client.handle(async (args: IHandlersOption) => {
        const method = args.method as string;
        const params = args.params;
        const response = synthesizeLocalResponse(method, params);
        observe(state, method, params, response);
        changeFeed.notify(identity);
        console.log(
          formatExchangeLog('EV Charger -> Local (unconfigured)', identity, method, params, {
            ok: true,
            response,
          }),
        );
        return response;
      });

      client.on('close', () => {
        console.log(`[disconnect] ${identity} (local mode)`);
        // Guard against a fast reconnect race: only remove if the map still
        // holds THIS client instance (a newer connection may have already
        // replaced it).
        if (localClients.get(identity) === client) {
          localClients.delete(identity);
        }
      });
      return;
    }

    console.log(`[connect] ${identity}`);

    // buildPrimaryConnectionOptions() can throw synchronously (e.g. a
    // malformed origin cloud URL, see originConnection.ts) - it MUST be
    // caught here. Left unguarded, the exception propagates up through this
    // synchronous 'client' event handler into ocpp-rpc's own connection
    // setup, which reacts by closing the raw WebSocket with the error's
    // message as the close reason - and a WS close frame is capped at 123
    // bytes, so a long, helpful error message crashes the ENTIRE gateway
    // process with an unrelated RangeError instead of just rejecting this
    // one connection.
    let primaryConn: ReturnType<typeof buildPrimaryConnectionOptions>;
    try {
      primaryConn = buildPrimaryConnectionOptions(originCloudUrl, identity);
    } catch (err) {
      console.error(
        `[connect] ${identity}: cannot determine the origin cloud connection: ${(err as Error).message ?? err}`,
      );
      client.close({ code: 1011, reason: 'gateway configuration error' }).catch(() => {});
      return;
    }

    const primaryClient = new RPCClient({
      endpoint: primaryConn.endpoint,
      identity: primaryConn.identity,
      query: primaryConn.query,
      protocols,
    } as ConstructorParameters<typeof RPCClient>[0]);

    // CALL initiated by the charge point: relayed to the primary (only its
    // response matters to the charge point, asymmetry by design), then
    // observed to update the internal state. Every exchange is logged in
    // full (timestamp, params, response/error) - the only way to see what's
    // actually happening on the wire, read via Gladys's container log viewer.
    client.handle(async (args: IHandlersOption) => {
      const method = args.method as string;
      const params = args.params;
      const signal = args.signal as AbortSignal;

      try {
        const response = await primaryClient.call(method, params, { signal });
        observe(state, method, params, response);
        changeFeed.notify(identity);
        console.log(
          formatExchangeLog('EV Charger -> Primary', identity, method, params, {
            ok: true,
            response,
          }),
        );
        return response;
      } catch (err) {
        observe(state, method, params, undefined);
        changeFeed.notify(identity);
        console.error(
          formatExchangeLog('EV Charger -> Primary', identity, method, params, {
            ok: false,
            error: (err as Error).message ?? String(err),
          }),
        );
        throw err;
      }
    });

    // CALL initiated by the primary (origin cloud): forwarded to the charge
    // point, response sent back to the primary.
    primaryClient.handle(async (args: IHandlersOption) => {
      const method = args.method as string;
      const params = args.params;
      try {
        const response = await client.call(method, params, { signal: args.signal as AbortSignal });
        console.log(
          formatExchangeLog('Primary -> EV Charger', identity, method, params, {
            ok: true,
            response,
          }),
        );
        return response;
      } catch (err) {
        console.error(
          formatExchangeLog('Primary -> EV Charger', identity, method, params, {
            ok: false,
            error: (err as Error).message ?? String(err),
          }),
        );
        throw err;
      }
    });

    primaryClient.connect().catch((err: unknown) => {
      console.error(`[primary:${identity}] connection failed: ${(err as Error).message ?? err}`);
    });

    client.on('close', () => {
      console.log(`[disconnect] ${identity}`);
      primaryClient.close().catch(() => {});
    });
  });

  return server;
}

async function main() {
  const port = Number.parseInt(process.env.GATEWAY_PORT ?? '9321', 10);
  const server = createGatewayServer();

  await server.listen(port);
  console.log(`gateway listening on ws://0.0.0.0:${port}/`);

  const stateApiPort = Number.parseInt(process.env.UI_PORT ?? '9080', 10);
  const stateApiServer = createStateApiServer(store, registry, localClients, changeFeed);
  await new Promise<void>((resolve) => stateApiServer.listen(stateApiPort, resolve));
  console.log(
    `gateway internal state API listening on http://0.0.0.0:${stateApiPort}/ (private network only)`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    stateApiServer.close();
    await server.close({});
    process.exit(0);
  };
  // Docker/the Gladys supervisor sends SIGTERM on stop, not SIGINT - both
  // must be handled for a clean shutdown under real container orchestration.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
