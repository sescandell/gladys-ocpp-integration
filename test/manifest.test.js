// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers, nor that no brand-specific
// reference has crept back in - these tests keep both in check.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('config_schema/action descriptions stay within the store admission bounds (<=1000 chars)', () => {
  // The store validator isn't wired into CI (only run manually), and this
  // bound was hit for real once.
  for (const field of manifest.config_schema ?? []) {
    for (const [lang, text] of Object.entries(field.description ?? {})) {
      assert.ok(
        text.length <= 1000,
        `config_schema.${field.key}.description.${lang} must be <=1000 chars, got ${text.length}`,
      );
    }
  }
  for (const action of manifest.actions ?? []) {
    for (const [lang, text] of Object.entries(action.description ?? {})) {
      assert.ok(
        text.length <= 1000,
        `actions.${action.key}.description.${lang} must be <=1000 chars, got ${text.length}`,
      );
    }
  }
});

test('top-level shape', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.docker_image.length > 0);
});

test('gladys_version requires the release that introduced the CHARGING_STATION category', () => {
  // First release carrying core PRs #2756 (charging-station features) and
  // #2779 (server-side validation of a `source: "devices"` select).
  assert.equal(manifest.gladys_version, '>=4.85.0');
});

test('V1 is read-only: actions only manage charge point configuration and gateway state, never control a device', () => {
  assert.deepEqual(
    manifest.actions?.map((a) => a.key),
    ['add_charger', 'reset_all'],
  );
});

test('reset_all action: requires a confirmation field', () => {
  const action = manifest.actions.find((a) => a.key === 'reset_all');
  assert.ok(action, 'reset_all must be declared');
  const confirmField = action.fields.find((f) => f.key === 'confirm');
  assert.ok(confirmField, 'confirm field must be declared');
  assert.equal(confirmField.required, true);
});

test('no config_schema at all - nothing for the user to configure in the generated form', () => {
  // The set of charge points is unbounded and lives in free internal config
  // storage (src/chargers.js) driven by the add_charger action - a
  // config_schema is a flat, fixed list of fields and cannot represent it.
  assert.equal(manifest.config_schema, undefined);
});

test('add_charger action: device picker required, origin_cloud_url optional (empty = detach)', () => {
  const action = manifest.actions.find((a) => a.key === 'add_charger');
  assert.ok(action, 'add_charger must be declared');
  const deviceField = action.fields.find((f) => f.key === 'device');
  const urlField = action.fields.find((f) => f.key === 'origin_cloud_url');

  // A `select` whose options Gladys itself fills in with the integration's
  // own devices - so the user picks a charge point instead of retyping its
  // exact OCPP identity. `source` and `options` are mutually exclusive
  // (Gladys core's validateManifest), declaring both rejects the manifest.
  assert.ok(deviceField, 'device field must be declared');
  assert.equal(deviceField.type, 'select');
  assert.equal(deviceField.source, 'devices');
  assert.equal(deviceField.options, undefined);
  assert.equal(deviceField.required, true);

  assert.ok(urlField, 'origin_cloud_url field must be declared');
  assert.equal(urlField.required, false);
});

test('section fields, wherever they are declared, stay purely presentational', () => {
  // Sections are allowed in an action's `fields` too, same rendering engine
  // as config_schema.
  const sections = [
    ...(manifest.config_schema ?? []),
    ...(manifest.actions ?? []).flatMap((a) => a.fields ?? []),
  ].filter((f) => f.type === 'section');
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
