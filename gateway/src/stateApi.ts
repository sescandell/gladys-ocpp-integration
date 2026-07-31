/**
 * Internal data contract between this sub-container and the main integration
 * container: a single `GET /api/state` JSON endpoint, polled over the private
 * Docker network (`http://gateway:<UI_PORT>`, see `../src/gatewayClient.js`).
 *
 * Deliberately NOT a debug dashboard: no static files, no HTML, nothing meant
 * to be opened in a browser or published on the LAN. Troubleshooting the
 * relay itself goes through Gladys's built-in container logs viewer (the
 * Configuration screen's supervision block, container selector -> "gateway"),
 * which reads stdout/stderr the same way `docker logs` would - see the
 * `console.log`/`console.error` calls in `gateway.ts`.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import type { StateStore } from './state.ts';

export function createStateApiServer(store: StateStore): Server {
  return createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(store.toJSON()));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });
}
