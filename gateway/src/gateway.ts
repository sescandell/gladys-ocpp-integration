/**
 * OCPP 1.6 relay (charge point <-> configured origin cloud), the companion
 * sub-container of the Gladys OCPP integration.
 *
 * This file has no idea it may run under Gladys supervision: it only speaks
 * OCPP + a tiny internal HTTP state API (see `stateApi.ts`), nothing specific
 * to the Gladys SDK lives here - that lives in the main integration container
 * (`../index.js`), which polls this process over its private-network DNS
 * alias (see `../src/gatewayClient.js`).
 *
 * Two connections per charge point: a CSMS-side server facing the charge
 * point, and an OCPP client facing the configured origin cloud (the
 * "primary"). The business logic is an OBSERVATION of the primary's REAL
 * response, never an autonomous decision: the transactionId recorded in the
 * internal state is the one the primary assigned, never invented locally -
 * otherwise the history would not match what the charge point/cloud actually
 * use for a later StopTransaction.
 *
 * Response asymmetry: for a CALL initiated by the charge point, only the
 * primary's response matters to the charge point. Multi-charge-point
 * isolation: one (charge point client, primary client) pair per identity,
 * closed over its own connection closure, no shared state. No strictMode
 * (faithful passthrough, including vendor-specific messages not covered by
 * the OCPP schema embedded in ocpp-rpc).
 */

import { fileURLToPath } from 'node:url';
import { RPCServer, RPCClient } from 'ocpp-rpc';
import type { IHandlersOption } from 'ocpp-rpc';
import { StateStore } from './state.ts';
import { observe } from './observe.ts';
import { createStateApiServer } from './stateApi.ts';
import {
  buildPrimaryConnectionOptions,
  type PrimaryConnectionOptions,
} from './originConnection.ts';

export interface GatewayOptions {
  protocols?: string[];
  buildPrimaryConnection(identity: string): PrimaryConnectionOptions;
}

const DEFAULT_PROTOCOLS = ['ocpp1.6'];

export const store = new StateStore();

export function createGatewayServer(options: GatewayOptions) {
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
    console.log(`[connect] ${identity}`);

    const primaryConn = options.buildPrimaryConnection(identity);
    const primaryClient = new RPCClient({
      endpoint: primaryConn.endpoint,
      identity: primaryConn.identity,
      query: primaryConn.query,
      protocols,
    } as ConstructorParameters<typeof RPCClient>[0]);

    // CALL initiated by the charge point: relayed to the primary (only its
    // response matters to the charge point, asymmetry by design), then
    // observed to update the internal state.
    client.handle(async (args: IHandlersOption) => {
      const method = args.method as string;
      const params = args.params;
      const signal = args.signal as AbortSignal;

      try {
        const response = await primaryClient.call(method, params, { signal });
        observe(state, method, params, response);
        return response;
      } catch (err) {
        observe(state, method, params, undefined);
        console.error(`[relay:${identity}] ${method} failed: ${(err as Error).message ?? err}`);
        throw err;
      }
    });

    // CALL initiated by the primary (origin cloud): forwarded to the charge
    // point, response sent back to the primary.
    primaryClient.handle(async (args: IHandlersOption) => {
      const method = args.method as string;
      try {
        return await client.call(method, args.params, { signal: args.signal as AbortSignal });
      } catch (err) {
        console.error(
          `[relay:${identity}] primary->charge point ${method} failed: ${(err as Error).message ?? err}`,
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
  const originCloudUrl = process.env.ORIGIN_CLOUD_URL;
  if (!originCloudUrl) {
    throw new Error('ORIGIN_CLOUD_URL is required');
  }

  const buildPrimaryConnection = (identity: string) =>
    buildPrimaryConnectionOptions(originCloudUrl, identity);
  const server = createGatewayServer({ buildPrimaryConnection });

  await server.listen(port);
  console.log(`gateway listening on ws://0.0.0.0:${port}/`);

  const stateApiPort = Number.parseInt(process.env.UI_PORT ?? '9080', 10);
  const stateApiServer = createStateApiServer(store);
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
