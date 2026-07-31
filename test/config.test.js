import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigured, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    origin_cloud_url: 'wss://cloud.example.com/ocpp',
    poll_frequency: 60,
  });
  assert.equal(config.origin_cloud_url, 'wss://cloud.example.com/ocpp');
  assert.equal(config.poll_frequency, 60);
});

test('normalizeConfig trims the origin cloud URL', () => {
  const config = normalizeConfig({ origin_cloud_url: '  wss://cloud.example.com/ocpp  ' });
  assert.equal(config.origin_cloud_url, 'wss://cloud.example.com/ocpp');
});

test('normalizeConfig coerces a numeric string coming from a form', () => {
  const config = normalizeConfig({ poll_frequency: '600' });
  assert.equal(config.poll_frequency, 600);
  assert.equal(typeof config.poll_frequency, 'number');
});

test('normalizeConfig falls back to the default for a missing numeric field', () => {
  const config = normalizeConfig({ origin_cloud_url: 'wss://cloud.example.com/ocpp' });
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
});

test('isConfigured is false until an origin cloud URL is set', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ origin_cloud_url: '   ' })), false);
  assert.equal(
    isConfigured(normalizeConfig({ origin_cloud_url: 'wss://cloud.example.com/ocpp' })),
    true,
  );
});
