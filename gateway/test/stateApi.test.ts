import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateApiServer } from '../src/stateApi.ts';
import { StateStore } from '../src/state.ts';
import { ChargerRegistry } from '../src/chargerRegistry.ts';

async function withServer(
  t: any,
  fn: (baseUrl: string, store: StateStore, registry: ChargerRegistry) => Promise<void>,
) {
  const store = new StateStore();
  const registry = new ChargerRegistry();
  const server = createStateApiServer(store, registry);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  await fn(`http://127.0.0.1:${port}`, store, registry);
}

test('GET /api/state returns chargers and pending', async (t) => {
  await withServer(t, async (baseUrl, store, registry) => {
    store.get('CP-1').patchConnector(1, { status: 'Charging' });
    registry.recordPending('CP-2');

    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.chargers['CP-1'].connectors[1].status, 'Charging');
    assert.equal(body.pending[0].identity, 'CP-2');
  });
});

test('POST /api/chargers replaces the live map', async (t) => {
  await withServer(t, async (baseUrl, _store, registry) => {
    const res = await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chargers: { 'CP-1': 'wss://cloud-a/ocpp' } }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.configuredCount, 1);
    assert.equal(registry.resolve('CP-1'), 'wss://cloud-a/ocpp');
  });
});

test('POST /api/chargers rejects a non-object chargers field', async (t) => {
  await withServer(t, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      body: JSON.stringify({ chargers: ['not', 'an', 'object'] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.success, false);
  });
});

test('POST /api/chargers rejects a non-string value', async (t) => {
  await withServer(t, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      body: JSON.stringify({ chargers: { 'CP-1': 42 } }),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /api/chargers rejects invalid JSON', async (t) => {
  await withServer(t, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/chargers`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
  });
});

test('unknown route returns 404', async (t) => {
  await withServer(t, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/nope`);
    assert.equal(res.status, 404);
  });
});
