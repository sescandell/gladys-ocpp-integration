import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults (plus an empty chargers store) when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), { ...DEFAULT_CONFIG, chargers: {} });
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({ poll_frequency: 60 });
  assert.equal(config.poll_frequency, 60);
});

test('normalizeConfig coerces a numeric string coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '600' });
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig falls back to the default for a missing numeric field', () => {
  const config = normalizeConfig({});
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('normalizeConfig folds the parsed charger store in as `chargers`', () => {
  const config = normalizeConfig({
    chargers_json: JSON.stringify({ 'CP-1': 'wss://cloud-a/ocpp' }),
  });
  assert.deepEqual(config.chargers, { 'CP-1': 'wss://cloud-a/ocpp' });
});
