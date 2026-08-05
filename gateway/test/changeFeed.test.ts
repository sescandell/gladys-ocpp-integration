import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChangeFeed, type ChargerChange } from '../src/changeFeed.ts';
import { StateStore } from '../src/state.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('notify emits the charge point full observed state', async () => {
  const store = new StateStore();
  const feed = createChangeFeed(store, { coalesceMs: 0 });
  const seen: ChargerChange[] = [];
  feed.subscribe((change) => seen.push(change));

  store.get('CP-1').patchConnector(1, { status: 'Charging' });
  feed.notify('CP-1');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].identity, 'CP-1');
  assert.equal(seen[0].charger.connectors[1].status, 'Charging');
});

test('a burst on one identity is coalesced into a single event carrying the newest state', async () => {
  // A charge point sending StatusNotification then MeterValues back to back
  // must not cost two publications downstream (Gladys caps states per minute).
  const store = new StateStore();
  const feed = createChangeFeed(store, { coalesceMs: 10 });
  const seen: ChargerChange[] = [];
  feed.subscribe((change) => seen.push(change));

  store.get('CP-1').patchConnector(1, { status: 'Preparing' });
  feed.notify('CP-1');
  feed.notify('CP-1');
  store.get('CP-1').patchConnector(1, { status: 'Charging', voltageV: 230 });
  feed.notify('CP-1');

  await wait(30);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].charger.connectors[1].status, 'Charging');
  assert.equal(seen[0].charger.connectors[1].voltageV, 230);
});

test('two identities are coalesced independently', async () => {
  const store = new StateStore();
  const feed = createChangeFeed(store, { coalesceMs: 10 });
  const seen: ChargerChange[] = [];
  feed.subscribe((change) => seen.push(change));

  feed.notify('CP-1');
  feed.notify('CP-2');

  await wait(30);
  assert.deepEqual(seen.map((c) => c.identity).sort(), ['CP-1', 'CP-2']);
});

test('unsubscribing stops delivery, and close() drops every listener', async () => {
  const store = new StateStore();
  const feed = createChangeFeed(store, { coalesceMs: 0 });
  const seen: ChargerChange[] = [];
  const unsubscribe = feed.subscribe((change) => seen.push(change));
  feed.subscribe(() => {});
  assert.equal(feed.listenerCount, 2);

  unsubscribe();
  feed.notify('CP-1');
  assert.equal(seen.length, 0);
  assert.equal(feed.listenerCount, 1);

  feed.close();
  assert.equal(feed.listenerCount, 0);
});

test('a throwing subscriber neither stops the others nor bubbles into the OCPP handler', async () => {
  const store = new StateStore();
  const feed = createChangeFeed(store, { coalesceMs: 0 });
  const seen: string[] = [];
  feed.subscribe(() => {
    throw new Error('subscriber blew up');
  });
  feed.subscribe((change) => seen.push(change.identity));

  assert.doesNotThrow(() => feed.notify('CP-1'));
  assert.deepEqual(seen, ['CP-1']);
});
