// -----------------------------------------------------------------------------
// Web UI + JSON API of the simulator. Standalone: `npm start` in simulator/.
//
//   GET  /api/state               snapshot (config, connection, connectors, scenario)
//   GET  /api/events              Server-Sent Events: `state` snapshots and `log` lines
//   PUT  /api/config              partial configuration (URL, identity, ...)
//   POST /api/connect | /api/disconnect
//   POST /api/connectors/:id/:action   plug | unplug | start | stop | pause | resume |
//                                      power | fault | clear-fault | status
//   POST /api/scenarios/:key      run a scripted situation ; POST /api/scenarios/stop
//
// Listens on 127.0.0.1 by default (SIM_HOST=0.0.0.0 to reach it from another
// machine); the port is SIM_PORT (default 8088).
// -----------------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SimulatedChargePoint, STATUSES, ERROR_CODES } from './chargePoint.js';
import { ScenarioRunner, listScenarios } from './scenarios.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_LOGS = 300;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}

/**
 * @param {{configFile?: string|null, chargePoint?: SimulatedChargePoint}} [options]
 */
export async function createSimulator({
  configFile = `${ROOT}.sim-config.json`,
  chargePoint,
} = {}) {
  const cp = chargePoint ?? new SimulatedChargePoint();
  const logs = [];
  const streams = new Set();

  if (configFile) {
    try {
      cp.configure(JSON.parse(await readFile(configFile, 'utf8')));
    } catch {
      // First run, or an unreadable file: defaults.
    }
  }
  const saveConfig = () =>
    configFile
      ? writeFile(configFile, JSON.stringify(cp.config, null, 2)).catch(() => {})
      : Promise.resolve();

  const push = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(frame);
  };
  const snapshot = () => ({
    ...cp.snapshot(),
    scenario: runner.state,
    scenarios: listScenarios(),
    statuses: STATUSES,
    errorCodes: ERROR_CODES,
  });
  // Meter ticks and status changes come in bursts: coalesce the pushes.
  let pending = null;
  const pushState = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      push('state', snapshot());
    }, 100);
    pending.unref?.();
  };
  const addLog = (entry) => {
    logs.push(entry);
    if (logs.length > MAX_LOGS) logs.shift();
    push('log', entry);
  };

  const runner = new ScenarioRunner(cp, {
    onChange: pushState,
    onError: (err) => addLog({ at: new Date().toISOString(), kind: 'error', text: err.message }),
  });
  cp.on('change', pushState);
  cp.on('log', addLog);

  const connectorActions = {
    plug: (id) => cp.plugIn(id),
    unplug: (id) => cp.unplug(id),
    start: (id, body) =>
      cp.startCharge(id, { powerW: body.powerW, idTag: body.idTag || undefined }),
    stop: (id) => cp.stopCharge(id),
    pause: (id, body) => cp.pause(id, body.by === 'EVSE' ? 'EVSE' : 'EV'),
    resume: (id) => cp.resume(id),
    power: (id, body) => cp.setPower(id, body.powerW),
    fault: (id, body) => cp.fault(id, body.errorCode || 'GroundFailure'),
    'clear-fault': (id) => cp.clearFault(id),
    status: (id, body) => cp.setStatus(id, body.status, body.errorCode || 'NoError'),
  };

  async function route(req, res, url) {
    const method = req.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/api/state') return json(res, 200, snapshot());

    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: init\ndata: ${JSON.stringify({ state: snapshot(), logs })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return undefined;
    }

    if (method === 'PUT' && path === '/api/config') {
      const body = await readBody(req);
      const allowed = Object.keys(cp.config);
      const patch = Object.fromEntries(
        Object.entries(body).filter(([key]) => allowed.includes(key)),
      );
      cp.configure(patch);
      await saveConfig();
      return json(res, 200, snapshot());
    }

    if (method === 'POST' && path === '/api/connect') {
      await cp.connect();
      return json(res, 200, snapshot());
    }
    if (method === 'POST' && path === '/api/disconnect') {
      runner.stop();
      await cp.disconnect();
      return json(res, 200, snapshot());
    }

    const connectorRoute = path.match(/^\/api\/connectors\/(\d+)\/([\w-]+)$/);
    if (method === 'POST' && connectorRoute) {
      const action = connectorActions[connectorRoute[2]];
      if (!action) return json(res, 404, { error: `Unknown action ${connectorRoute[2]}` });
      await action(Number(connectorRoute[1]), await readBody(req));
      return json(res, 200, snapshot());
    }

    if (method === 'POST' && path === '/api/scenarios/stop') {
      runner.stop();
      return json(res, 200, snapshot());
    }
    const scenarioRoute = path.match(/^\/api\/scenarios\/([\w-]+)$/);
    if (method === 'POST' && scenarioRoute) {
      const body = await readBody(req);
      await runner.start(scenarioRoute[1], {
        connector: Number(body.connector) || 1,
        durationSec: Math.max(5, Number(body.durationSec) || 60),
        powerW: body.powerW === undefined || body.powerW === '' ? undefined : Number(body.powerW),
      });
      return json(res, 200, snapshot());
    }

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(`${ROOT}public/index.html`, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    return json(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    route(req, res, url).catch((err) => {
      if (!res.headersSent) json(res, 400, { error: err.message });
    });
  });

  return {
    server,
    chargePoint: cp,
    async close() {
      runner.stop();
      await cp.disconnect();
      for (const res of streams) res.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const port = Number.parseInt(process.env.SIM_PORT ?? '8088', 10);
  const host = process.env.SIM_HOST ?? '127.0.0.1';
  const simulator = await createSimulator();
  await new Promise((resolve) => simulator.server.listen(port, host, resolve));
  console.log(`OCPP simulator UI: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);

  const shutdown = async () => {
    await simulator.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
