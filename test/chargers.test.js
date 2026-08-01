import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChargersStore,
  serializeChargersStore,
  upsertCharger,
  removeCharger,
} from '../src/chargers.js';

test('parseChargersStore returns {} when the key is absent', () => {
  assert.deepEqual(parseChargersStore({}), {});
  assert.deepEqual(parseChargersStore(), {});
});

test('parseChargersStore returns {} on invalid JSON', () => {
  assert.deepEqual(parseChargersStore({ chargers_json: 'not json' }), {});
});

test('parseChargersStore returns {} for a non-object JSON value (array, string, number)', () => {
  assert.deepEqual(parseChargersStore({ chargers_json: '[1,2,3]' }), {});
  assert.deepEqual(parseChargersStore({ chargers_json: '"hello"' }), {});
  assert.deepEqual(parseChargersStore({ chargers_json: '42' }), {});
});

test('parseChargersStore parses a valid identity -> URL map', () => {
  const raw = {
    chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp', 'CP-2': 'wss://cloud-b/ocpp' }),
  };
  assert.deepEqual(parseChargersStore(raw), {
    'CP-1': 'wss://cloud-a/ocpp',
    'CP-2': 'wss://cloud-b/ocpp',
  });
});

test('parseChargersStore drops entries with an empty identity or URL', () => {
  const raw = {
    chargers_json: JSON.stringify({ 'CP-1': 'wss://ok', '': 'wss://no-identity', 'CP-2': '' }),
  };
  assert.deepEqual(parseChargersStore(raw), { 'CP-1': 'wss://ok' });
});

test('parseChargersStore trims identity and URL', () => {
  const raw = { chargers_json: JSON.stringify({ '  CP-1  ': '  wss://ok  ' }) };
  assert.deepEqual(parseChargersStore(raw), { 'CP-1': 'wss://ok' });
});

test('serializeChargersStore round-trips through parseChargersStore', () => {
  const chargers = { 'CP-1': 'wss://cloud-a/ocpp' };
  const stored = serializeChargersStore(chargers);
  assert.deepEqual(parseChargersStore(stored), chargers);
});

test('upsertCharger adds a new entry without touching the others', () => {
  const chargers = { 'CP-1': 'wss://cloud-a/ocpp' };
  const result = upsertCharger(chargers, 'CP-2', 'wss://cloud-b/ocpp');
  assert.deepEqual(result, { 'CP-1': 'wss://cloud-a/ocpp', 'CP-2': 'wss://cloud-b/ocpp' });
  assert.deepEqual(chargers, { 'CP-1': 'wss://cloud-a/ocpp' }); // original untouched
});

test('upsertCharger overwrites an existing entry', () => {
  const chargers = { 'CP-1': 'wss://old' };
  const result = upsertCharger(chargers, 'CP-1', 'wss://new');
  assert.deepEqual(result, { 'CP-1': 'wss://new' });
});

test('removeCharger drops the entry, keeps the others', () => {
  const chargers = { 'CP-1': 'wss://a', 'CP-2': 'wss://b' };
  const result = removeCharger(chargers, 'CP-1');
  assert.deepEqual(result, { 'CP-2': 'wss://b' });
});

test('removeCharger is a no-op for an unknown identity', () => {
  const chargers = { 'CP-1': 'wss://a' };
  assert.deepEqual(removeCharger(chargers, 'CP-unknown'), { 'CP-1': 'wss://a' });
});
