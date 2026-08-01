import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChargerRegistry } from '../src/chargerRegistry.ts';

test('resolve returns undefined for an unconfigured identity', () => {
  const registry = new ChargerRegistry();
  assert.equal(registry.resolve('CP-1'), undefined);
});

test('replaceMap makes identities resolvable', () => {
  const registry = new ChargerRegistry();
  registry.replaceMap({ 'CP-1': 'wss://cloud-a/ocpp', 'CP-2': 'wss://cloud-b/ocpp' });
  assert.equal(registry.resolve('CP-1'), 'wss://cloud-a/ocpp');
  assert.equal(registry.resolve('CP-2'), 'wss://cloud-b/ocpp');
  assert.equal(registry.resolve('CP-3'), undefined);
});

test('replaceMap fully replaces the previous map (no merge)', () => {
  const registry = new ChargerRegistry();
  registry.replaceMap({ 'CP-1': 'wss://old' });
  registry.replaceMap({ 'CP-2': 'wss://new' });
  assert.equal(registry.resolve('CP-1'), undefined);
  assert.equal(registry.resolve('CP-2'), 'wss://new');
});

test('recordPending creates a new entry with matching firstSeenAt/lastSeenAt', () => {
  const registry = new ChargerRegistry();
  registry.recordPending('CP-1');
  const [entry] = registry.pendingList();
  assert.equal(entry.identity, 'CP-1');
  assert.equal(entry.firstSeenAt, entry.lastSeenAt);
});

test('recordPending on an already-pending identity refreshes lastSeenAt but keeps firstSeenAt', async () => {
  const registry = new ChargerRegistry();
  registry.recordPending('CP-1');
  const first = registry.pendingList()[0];

  await new Promise((resolve) => setTimeout(resolve, 5));
  registry.recordPending('CP-1');
  const second = registry.pendingList()[0];

  assert.equal(second.firstSeenAt, first.firstSeenAt);
  assert.ok(second.lastSeenAt >= first.lastSeenAt);
  assert.equal(registry.pendingList().length, 1);
});

test('replaceMap clears a now-configured identity from the pending list', () => {
  const registry = new ChargerRegistry();
  registry.recordPending('CP-1');
  assert.equal(registry.pendingList().length, 1);

  registry.replaceMap({ 'CP-1': 'wss://cloud-a/ocpp' });
  assert.equal(registry.pendingList().length, 0);
});

test('pending list is capped, evicting the oldest entry first', async () => {
  const registry = new ChargerRegistry();
  // Populate beyond the cap (50) - cheap since recordPending is synchronous.
  for (let i = 0; i < 51; i += 1) {
    registry.recordPending(`CP-${i}`);
  }
  const identities = registry.pendingList().map((e) => e.identity);
  assert.equal(identities.length, 50);
  assert.equal(identities.includes('CP-0'), false); // oldest, evicted
  assert.equal(identities.includes('CP-50'), true); // newest, kept
});

test('toJSON reports the configured count and the pending list', () => {
  const registry = new ChargerRegistry();
  registry.replaceMap({ 'CP-1': 'wss://a', 'CP-2': 'wss://b' });
  registry.recordPending('CP-3');
  const json = registry.toJSON();
  assert.equal(json.configuredCount, 2);
  assert.equal(json.pending.length, 1);
  assert.equal(json.pending[0].identity, 'CP-3');
});
