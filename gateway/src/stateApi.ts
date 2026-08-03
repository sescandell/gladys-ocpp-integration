/**
 * Internal data contract between this sub-container and the main integration
 * container, polled/called over the private Docker network
 * (`http://gateway:<UI_PORT>`, see `../src/gatewayClient.js`). Never exposed
 * to the LAN, never meant to be opened in a browser.
 *
 * - `GET /api/state`  - full observed state of every charge point the
 *   gateway currently knows about (both configured/relayed and
 *   local-mode/unconfigured - see gateway.ts, they land in the same
 *   `StateStore`).
 * - `POST /api/chargers` - full replace of the live identity -> origin cloud
 *   URL map (see `chargerRegistry.ts`), called by the main container every
 *   time the set of configured charge points changes (the `add_charger`
 *   action) or on every reconnection, so this process never needs to be
 *   restarted to pick up a config change. Any identity that just became
 *   configured AND is currently connected in local mode gets its live
 *   connection force-closed here, so it reconnects and picks up full relay
 *   mode (see gateway.ts's `localClients`) - naturally idempotent, since a
 *   subsequent push finds `registry.resolve()` already returning the URL
 *   and skips it.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { text } from 'node:stream/consumers';
import type { StateStore } from './state.ts';
import type { ChargerRegistry } from './chargerRegistry.ts';

/** The only surface stateApi.ts needs from a live charge-point connection. */
export interface LocalClient {
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

export function createStateApiServer(
  store: StateStore,
  registry: ChargerRegistry,
  localClients: Map<string, LocalClient>,
): Server {
  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ chargers: store.toJSON() }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chargers') {
      text(req)
        .then((body) => {
          const parsed = JSON.parse(body) as { chargers?: unknown };
          if (
            parsed.chargers === null ||
            typeof parsed.chargers !== 'object' ||
            Array.isArray(parsed.chargers)
          ) {
            throw new Error('body.chargers must be an object');
          }
          const entries = Object.entries(parsed.chargers as Record<string, unknown>);
          const chargers: Record<string, string> = {};
          for (const [identity, originCloudUrl] of entries) {
            if (typeof identity !== 'string' || typeof originCloudUrl !== 'string') {
              throw new Error(
                'body.chargers must map identity (string) -> origin cloud URL (string)',
              );
            }
            chargers[identity] = originCloudUrl;
          }

          // Snapshot BEFORE replaceMap(): identities newly gaining a
          // configured URL that are currently live in local mode.
          const newlyConfigured = Object.keys(chargers).filter(
            (identity) => registry.resolve(identity) === undefined && localClients.has(identity),
          );

          registry.replaceMap(chargers);

          for (const identity of newlyConfigured) {
            const client = localClients.get(identity);
            store.reset(identity);
            client
              ?.close({ code: 1000, reason: 'reconfigured - reconnect for full relay mode' })
              .catch(() => {});
          }

          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, configuredCount: Object.keys(chargers).length }));
        })
        .catch((err: unknown) => {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: (err as Error).message ?? String(err) }));
        });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}
