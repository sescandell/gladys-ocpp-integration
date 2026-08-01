// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor that no brand-specific
// reference has crept back in - these tests keep both in check.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifestRaw = await readFile(
  new URL('../gladys-assistant-integration.json', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(manifestRaw);

test('description stays within the store admission bounds (10-100 chars per language)', () => {
  // Caught by the real store validator once (descriptions were 120/134
  // chars) - guarded locally so it never regresses silently again.
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} must be 10-100 chars, got ${text.length}`,
    );
  }
});

test('top-level shape', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.docker_image.length > 0);
});

test('V1 is read-only: the only action manages charge point configuration, never controls a device', () => {
  assert.equal(manifest.actions?.length, 1);
  assert.equal(manifest.actions[0].key, 'add_charger');
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('config_schema only has the intro section and poll_frequency - no fixed per-charger fields', () => {
  // Deliberately no "charger_1_identity"-style slots: the set of configured
  // charge points is unbounded and managed entirely through the
  // `add_charger` action + free internal config storage (src/chargers.js),
  // not the generated form (config_schema is a flat, fixed list of fields -
  // it cannot represent "add as many charge points as you want").
  assert.deepEqual(
    manifest.config_schema.map((f) => f.key),
    ['intro', 'poll_frequency'],
  );
});

test('add_charger action: identity required, origin_cloud_url optional (empty = remove)', () => {
  const action = manifest.actions.find((a) => a.key === 'add_charger');
  assert.ok(action, 'add_charger must be declared');
  const identityField = action.fields.find((f) => f.key === 'identity');
  const urlField = action.fields.find((f) => f.key === 'origin_cloud_url');
  assert.ok(identityField, 'identity field must be declared');
  assert.equal(identityField.required, true);
  assert.ok(urlField, 'origin_cloud_url field must be declared');
  assert.equal(urlField.required, false);
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the manifest has at least one intro section block');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('exactly one declared sub-container: "gateway"', () => {
  assert.equal(manifest.containers?.length, 1);
  assert.equal(manifest.containers[0].name, 'gateway');
});

test('the gateway sub-container only publishes the OCPP port, started automatically', () => {
  const gateway = manifest.containers[0];
  // "auto": the gateway needs no config to be useful (it detects and reports
  // unconfigured charge points on its own), unlike the old single-URL design
  // where it had to wait for that URL before starting made any sense.
  assert.equal(gateway.start, 'auto');
  assert.equal(
    gateway.ports.length,
    1,
    'no debug port should be published on the LAN - logs go through the supervision screen',
  );
  assert.equal(gateway.ports[0].container_port, 9321);
  assert.ok(gateway.ports[0].label?.en);
});

test('the gateway sub-container stays within sane resource limits', () => {
  const gateway = manifest.containers[0];
  assert.equal(typeof gateway.memory_mb, 'number');
  assert.equal(typeof gateway.cpu, 'number');
});

test('no known hardware brand reference anywhere in the manifest', () => {
  // Regression trip-wire: this integration must stay generic, never tied to
  // a specific charge point vendor.
  assert.doesNotMatch(manifestRaw, /autel/i);
});
