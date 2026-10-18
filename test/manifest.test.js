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

test('gladys_version matches what the manifest actually needs', () => {
  // >=4.85.0: needed for the charging-station device feature category, the
  // gateway port's `browsable` flag, the `{{port:<name>}}` placeholder used
  // in the how_to section below, and \n-as-line-break rendering in
  // config_schema/action descriptions (core PR #2788, `white-space:
  // pre-wrap` in ConfigSchemaForm.jsx/ActionsCard.jsx).
  // >=5.1.0: dashboard widgets declared by external integrations (core PR
  // #3109) - the `widgets` field below rejects the manifest on older cores.
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('charger widget: one connector of one of our charge points', () => {
  assert.deepEqual(
    manifest.widgets?.map((w) => w.key),
    ['charger'],
  );
  const widget = manifest.widgets[0];
  // Core bounds (code-enforced, not in the JSON schema): label 3-30 chars,
  // description <= 100 chars, per language.
  for (const [lang, text] of Object.entries(widget.label)) {
    assert.ok(text.length >= 3 && text.length <= 30, `widget label.${lang}: ${text.length}`);
  }
  for (const [lang, text] of Object.entries(widget.description ?? {})) {
    assert.ok(text.length <= 100, `widget description.${lang}: ${text.length}`);
  }

  const device = widget.settings.find((f) => f.key === 'device');
  assert.equal(device.type, 'select');
  assert.equal(device.source, 'devices');
  assert.equal(device.required, true);

  // A default, so a single-connector charge point (the vast majority) needs
  // no extra setting.
  const connector = widget.settings.find((f) => f.key === 'connector');
  assert.equal(connector.type, 'number');
  assert.equal(connector.default, 1);
});

test('charger widget settings: options and defaults match the code', async () => {
  const { TILES, CHART_MODES, CHART_INTERVALS, DEFAULT_SETTINGS } =
    await import('../src/widgets/charger.js');
  const settings = new Map(manifest.widgets[0].settings.map((f) => [f.key, f]));
  const optionValues = (key) => settings.get(key).options.map((o) => o.value);

  // Saved widgets store these values: a rename on either side silently
  // breaks every widget already on a dashboard.
  assert.deepEqual(optionValues('tiles'), Object.values(TILES));
  assert.deepEqual(optionValues('chart'), Object.values(CHART_MODES));
  assert.deepEqual(optionValues('chart_interval'), CHART_INTERVALS);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    assert.deepEqual(settings.get(key).default, value, `settings.${key}.default`);
  }
  // No default price: without one, the widget never shows a made-up cost.
  assert.equal(settings.get('kwh_price').type, 'number');
  assert.equal(settings.get('kwh_price').default, undefined);
  assert.ok(settings.size <= 10, 'the core accepts at most 10 widget settings');
});

test('every declared widget has a handler registered by index.js', async () => {
  const { createFakeGladys } = await import('./helpers/fakeGladys.js');
  const { registerHandlers } = await import('../index.js');
  const gladys = createFakeGladys();
  registerHandlers(gladys, { discoveryRefreshIntervalMs: 0, eventStreamEnabled: false });
  assert.deepEqual(
    Object.keys(gladys.handlers.widgets).sort(),
    manifest.widgets.map((w) => w.key).sort(),
  );
});

test('V1 is read-only: the only action attaches an origin cloud, it never controls a device', () => {
  assert.deepEqual(
    manifest.actions?.map((a) => a.key),
    ['add_charger'],
  );
});

test('config_schema holds the walkthrough and nothing else - no field stores a value', () => {
  // The set of charge points is unbounded and lives in free internal config
  // storage (src/chargers.js) driven by the add_charger action - a
  // config_schema is a flat, fixed list of fields and cannot represent it.
  // What is left is the one thing a form is good at here: telling the user
  // what to do, on the screen where they do it.
  //
  // A SINGLE section, its steps separated by literal \n characters: core PR
  // #2788 renders config_schema/action descriptions with `white-space:
  // pre-wrap` (ConfigSchemaForm.jsx), so \n is an actual line break - no
  // need to split the walkthrough across several sections to get one.
  assert.deepEqual(
    manifest.config_schema.map((f) => f.key),
    ['how_to'],
  );
  assert.ok(
    manifest.config_schema.every((f) => f.type === 'section'),
    'every config_schema field must stay presentational',
  );
});

test('the how_to section separates its steps with literal \\n line breaks', () => {
  const howTo = manifest.config_schema.find((f) => f.key === 'how_to');
  for (const [lang, text] of Object.entries(howTo.description)) {
    assert.ok(text.includes('\n'), `how_to.description.${lang} must contain line breaks`);
  }
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
  const port = gateway.ports[0];
  assert.equal(port.container_port, 9321);
  assert.ok(port.label?.en);
  // Not a web UI (a raw OCPP WebSocket endpoint): an "Open" link would be
  // useless on the Supervision screen.
  assert.equal(port.browsable, false);
  // Named so config_schema's how_to section can embed the live URL via the
  // {{port:ocpp}} placeholder instead of pointing the user at the
  // Supervision screen.
  assert.equal(port.name, 'ocpp');
});

test('the how_to section embeds the live OCPP URL via the {{gladys_host}}/{{port:ocpp}} placeholders', () => {
  const howTo = manifest.config_schema.find((f) => f.key === 'how_to');
  const gatewayPortName = manifest.containers[0].ports[0].name;
  for (const [lang, text] of Object.entries(howTo.description)) {
    assert.match(text, /\{\{gladys_host\}\}/, `how_to.description.${lang}`);
    assert.ok(
      text.includes(`{{port:${gatewayPortName}}}`),
      `how_to.description.${lang} must reference the gateway port's declared name`,
    );
  }
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

test('charger widget: the number bounds match the ones enforced by the code', async () => {
  const { normalizeWidgetSettings } = await import('../src/widgets/charger.js');
  const settings = new Map(manifest.widgets[0].settings.map((f) => [f.key, f]));
  const connector = settings.get('connector');
  assert.equal(normalizeWidgetSettings({ connector: connector.max }).connector, connector.max);
  assert.equal(normalizeWidgetSettings({ connector: connector.max + 1 }).connector, 1);
  const price = settings.get('kwh_price');
  assert.equal(normalizeWidgetSettings({ kwh_price: price.max }).kwhPrice, price.max);
  assert.equal(normalizeWidgetSettings({ kwh_price: price.max + 1 }).kwhPrice, null);
});
