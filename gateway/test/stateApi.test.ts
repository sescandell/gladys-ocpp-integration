import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createStateApiServer, type LocalClient } from '../src/stateApi.ts';
import { StateStore } from '../src/state.ts';
import { ChargerRegistry } from '../src/chargerRegistry.ts';
import { createChangeFeed, type ChangeFeed } from '../src/changeFeed.ts';

async function withServer(
  t: any,
  fn: (
    baseUrl: string,
    store: StateStore,
    registry: ChargerRegistry,
    localClients: Map<string, LocalClient>,
    changeFeed: ChangeFeed,
  ) => Promise<void>,
) {
  const store = new StateStore();
  const registry = new ChargerRegistry();
  const localClients: Map<string, LocalClient> = new Map();
  const changeFeed = createChangeFeed(store, { coalesceMs: 0 });
  t.after(() => changeFeed.close());
  const server = createStateApiServer(store, registry, localClients, changeFeed);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  await fn(`http://127.0.0.1:${port}`, store, registry, localClients, changeFeed);
}

/** Reads SSE frames off a live response until `count` data frames arrived. */
async function readEvents(res: Response, count: number): Promise<any[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: any[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (data) events.push(JSON.parse(data));
      separator = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  return events;
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

test('GET /api/events streams one frame per change, carrying the full charger state', async (t) => {
  await withServer(t, async (baseUrl, store, _registry, _localClients, changeFeed) => {
    const res = await fetch(`${baseUrl}/api/events`, { headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const events = readEvents(res, 2);
    // The subscription is live only once the handler has registered its
    // listener, which happens before the first byte reaches us.
    while (changeFeed.listenerCount === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    store.get('CP-1').patchConnector(1, { status: 'Charging' });
    changeFeed.notify('CP-1');
    store.get('CP-2').patchConnector(2, { status: 'Available' });
    changeFeed.notify('CP-2');

    const received = await events;
    assert.deepEqual(
      received.map((e) => e.identity),
      ['CP-1', 'CP-2'],
    );
    assert.equal(received[0].charger.connectors[1].status, 'Charging');
    assert.equal(received[1].charger.connectors[2].status, 'Available');
  });
});

test('GET /api/events unsubscribes when the subscriber goes away', async (t) => {
  await withServer(t, async (baseUrl, _store, _registry, _localClients, changeFeed) => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    while (changeFeed.listenerCount === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    controller.abort();
    // The server sees the close asynchronously.
    while (changeFeed.listenerCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(changeFeed.listenerCount, 0);
  });
});
