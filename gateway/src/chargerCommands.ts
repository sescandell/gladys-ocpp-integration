/**
 * Everything the gateway itself initiates towards a connected charge point
 * (the rest of what it does is relaying and observing): the vendor modules'
 * probes after boot, and their commands on request. Nothing here knows any
 * manufacturer - that is `vendors/`. Reached through
 * `POST /api/chargers/...` (see stateApi.ts) when Gladys sets a feature.
 */

import type { StateStore } from './state.ts';
import type { ChangeFeed } from './changeFeed.ts';
import { CommandError } from './commandError.ts';
import { formatExchangeLog } from './exchangeLog.ts';
import { vendorModules } from './vendors/index.ts';
import type { VendorContext, VendorModule } from './vendors/types.ts';

/** The only surface needed from a live charge-point connection. */
export interface CallableClient {
  call(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

const CALL_TIMEOUT_MS = 10_000;

export interface ChargerCommands {
  /** Runs the vendor command `name` for one connector of a connected charge point. */
  run(identity: string, connectorId: number, name: string, value: unknown): Promise<void>;
  /** Lets every vendor module that applies find out what the charge point supports. */
  probe(identity: string): Promise<void>;
}

export function createChargerCommands(
  store: StateStore,
  liveClients: Map<string, CallableClient>,
  changeFeed: ChangeFeed,
  modules: readonly VendorModule[] = vendorModules,
): ChargerCommands {
  function contextFor(identity: string): VendorContext {
    const client = liveClients.get(identity);
    if (!client) {
      throw new CommandError(409, `${identity} is not connected`);
    }
    return {
      identity,
      state: store.get(identity),
      async call(method, params) {
        try {
          const response = await client.call(method, params, { timeoutMs: CALL_TIMEOUT_MS });
          console.log(
            formatExchangeLog('Gateway -> EV Charger', identity, method, params, {
              ok: true,
              response,
            }),
          );
          return response;
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          console.error(
            formatExchangeLog('Gateway -> EV Charger', identity, method, params, {
              ok: false,
              error: message,
            }),
          );
          throw new CommandError(502, `${identity} did not answer: ${message}`);
        }
      },
    };
  }

  return {
    async run(identity, connectorId, name, value) {
      const context = contextFor(identity);
      const applicable = modules.filter((module) => module.matches(context.state));
      const module = applicable.find((candidate) => Object.hasOwn(candidate.commands ?? {}, name));
      if (!module) {
        const known = modules.some((candidate) => Object.hasOwn(candidate.commands ?? {}, name));
        throw known
          ? new CommandError(422, `${identity} does not offer the command "${name}"`)
          : new CommandError(404, `Unknown command "${name}"`);
      }
      await module.commands![name]!(context, { connectorId, value });
      changeFeed.notify(identity);
    },

    async probe(identity) {
      let context: VendorContext;
      try {
        context = contextFor(identity);
      } catch {
        return; // gone again before the probe ran
      }
      for (const module of modules) {
        if (!module.probe || !module.matches(context.state)) continue;
        try {
          await module.probe(context);
        } catch (err) {
          // Not an error: the charge point just keeps its generic features.
          console.warn(
            `[probe:${module.id}] ${identity}: ${(err as Error).message ?? String(err)}`,
          );
        }
      }
      changeFeed.notify(identity);
    },
  };
}
