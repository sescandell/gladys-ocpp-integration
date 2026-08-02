import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('normalizeConfig returns just an empty chargers store when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), { chargers: {} });
});

test('normalizeConfig folds the parsed charger store in as `chargers`', () => {
  const config = normalizeConfig({
    chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }),
  });
  assert.deepEqual(config.chargers, { 'CP-1': 'wss://cloud-a/ocpp' });
});
