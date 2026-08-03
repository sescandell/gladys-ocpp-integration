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

test('toJSON reports the configured count', () => {
  const registry = new ChargerRegistry();
  registry.replaceMap({ 'CP-1': 'wss://a', 'CP-2': 'wss://b' });
  const json = registry.toJSON();
  assert.equal(json.configuredCount, 2);
});
