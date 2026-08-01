/**
 * Internal data contract between this sub-container and the main integration
 * container, polled/called over the private Docker network
 * (`http://gateway:<UI_PORT>`, see `../src/gatewayClient.js`). Never exposed
 * to the LAN, never meant to be opened in a browser.
 *
 * - `GET /api/state`  - full state of every configured charge point, plus
 *   the identities seen connecting without being configured yet ("pending").
 * - `POST /api/chargers` - full replace of the live identity -> origin cloud
 *   URL map (see `chargerRegistry.ts`), called by the main container every
 *   time the set of configured charge points changes (the `add_charger`
 *   action) or on every reconnection, so this process never needs to be
 *   restarted to pick up a config change.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { text } from 'node:stream/consumers';
import type { StateStore } from './state.ts';
import type { ChargerRegistry } from './chargerRegistry.ts';

export function createStateApiServer(store: StateStore, registry: ChargerRegistry): Server {
  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ chargers: store.toJSON(), pending: registry.pendingList() }));
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
          registry.replaceMap(chargers);
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
