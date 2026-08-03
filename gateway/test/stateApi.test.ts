import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStateApiServer, type LocalClient } from '../src/stateApi.ts';
import { StateStore } from '../src/state.ts';
import { ChargerRegistry } from '../src/chargerRegistry.ts';

async function withServer(
  t: any,
  fn: (
    baseUrl: string,
    store: StateStore,
    registry: ChargerRegistry,
    localClients: Map<string, LocalClient>,
  ) => Promise<void>,
) {
  const store = new StateStore();
  const registry = new ChargerRegistry();
  const localClients: Map<string, LocalClient> = new Map();
  const server = createStateApiServer(store, registry, localClients);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  await fn(`http://127.0.0.1:${port}`, store, registry, localClients);
}

function fakeLocalClient() {
  return { close: mock.fn((_options?: { code?: number; reason?: string }) => Promise.resolve()) };
}

test('GET /api/state returns the full observed state (configured and local-mode alike)', async (t) => {
  await withServer(t, async (baseUrl, store) => {
    store.get('CP-1').patchConnector(1, { status: 'Charging' });

    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.chargers['CP-1'].connectors[1].status, 'Charging');
    assert.equal(body.pending, undefined);
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

test('POST /api/chargers force-closes a live local-mode client for a newly-configured identity, and resets its state', async (t) => {
  await withServer(t, async (baseUrl, store, _registry, localClients) => {
    const client = fakeLocalClient();
    localClients.set('CP-1', client);
    store.get('CP-1').patchConnector(1, { status: 'Charging' });

    const res = await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chargers: { 'CP-1': 'wss://cloud-a/ocpp' } }),
    });

    assert.equal(res.status, 200);
    assert.equal(client.close.mock.calls.length, 1);
    const [options] = client.close.mock.calls[0].arguments as [{ code?: number; reason?: string }];
    assert.equal(options.code, 1000);
    assert.ok(options.reason && options.reason.length <= 123);
    // State was reset - the connector patched above is gone.
    assert.equal(store.get('CP-1').connectors.size, 0);
  });
});

test('POST /api/chargers does nothing to an identity absent from localClients', async (t) => {
  await withServer(t, async (baseUrl, _store, _registry, localClients) => {
    const res = await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chargers: { 'CP-1': 'wss://cloud-a/ocpp' } }),
    });
    assert.equal(res.status, 200);
    assert.equal(localClients.size, 0);
  });
});

test('POST /api/chargers is idempotent: a second push for an already-configured identity does not close it again', async (t) => {
  await withServer(t, async (baseUrl, _store, _registry, localClients) => {
    const client = fakeLocalClient();
    localClients.set('CP-1', client);

    const body = JSON.stringify({ chargers: { 'CP-1': 'wss://cloud-a/ocpp' } });
    await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(client.close.mock.calls.length, 1);

    // localClients isn't cleared by stateApi.ts itself (that's gateway.ts's
    // 'close' handler's job in production) - simulate the push happening
    // again before the real reconnect completes.
    await fetch(`${baseUrl}/api/chargers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(client.close.mock.calls.length, 1);
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
