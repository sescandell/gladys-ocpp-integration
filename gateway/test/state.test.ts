import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChargerState, StateStore } from '../src/state.ts';

test('connector() creates an empty entry on first access', () => {
  const state = new ChargerState('CP-1');
  const connector = state.connector(1);
  assert.equal(connector.status, 'Unknown');
  assert.equal(state.connectors.size, 1);
});

test('patchConnector accumulates multiple connectors dynamically', () => {
  const state = new ChargerState('CP-1');
  state.patchConnector(1, { status: 'Available' });
  state.patchConnector(2, { status: 'Charging' });
  assert.deepEqual([...state.connectors.keys()].sort(), [1, 2]);
  assert.equal(state.connector(1).status, 'Available');
  assert.equal(state.connector(2).status, 'Charging');
});

test('patchConnector updates lastSeenAt', () => {
  const state = new ChargerState('CP-1');
  assert.equal(state.lastSeenAt, null);
  state.patchConnector(1, { status: 'Available' });
  assert.notEqual(state.lastSeenAt, null);
});

test('startTransaction then stopTransaction moves the record into history', () => {
  const state = new ChargerState('CP-1');
  state.startTransaction(1, 42, 'tag-1', 1000, '2026-08-01T10:00:00.000Z');
  assert.equal(state.transactions.size, 1);
  assert.equal(state.connector(1).transactionId, 42);

  const record = state.stopTransaction(42, 1500, '2026-08-01T11:00:00.000Z', 'Local');
  assert.ok(record);
  assert.equal(record?.meterStop, 1500);
  assert.equal(state.transactions.size, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.connector(1).transactionId, null);
});

test('stopTransaction returns null for an unknown transactionId', () => {
  const state = new ChargerState('CP-1');
  const record = state.stopTransaction(999, 100, '2026-08-01T11:00:00.000Z', null);
  assert.equal(record, null);
});

test('history is capped at 20 entries', () => {
  const state = new ChargerState('CP-1');
  for (let i = 1; i <= 25; i += 1) {
    state.startTransaction(1, i, 'tag', 0, '2026-08-01T10:00:00.000Z');
    state.stopTransaction(i, 10, '2026-08-01T10:05:00.000Z', null);
  }
  assert.equal(state.history.length, 20);
  // Most recent first.
  assert.equal(state.history[0].transactionId, 25);
});

test('StateStore.get creates a ChargerState per identity, reused on subsequent calls', () => {
  const store = new StateStore();
  const a = store.get('CP-1');
  const b = store.get('CP-1');
  const c = store.get('CP-2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(store.chargers.size, 2);
});

test('StateStore.toJSON serializes every charger, connectors keyed by id', () => {
  const store = new StateStore();
  store.get('CP-1').patchConnector(1, { status: 'Charging' });
  const json = store.toJSON();
  assert.equal(json['CP-1'].identity, 'CP-1');
  assert.equal(json['CP-1'].connectors[1].status, 'Charging');
});
