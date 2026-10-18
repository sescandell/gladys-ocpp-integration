// -----------------------------------------------------------------------------
// The generic code must stay free of any manufacturer: whatever is specific to
// one lives under a `vendors/` folder (see src/vendors/index.js and
// gateway/src/vendors/types.ts). This trips the moment a brand name or one of
// its protocol identifiers creeps back into the OCPP core, the widget, the
// device definition or the manifest.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

// Brand names and the identifiers of their protocol extensions.
const FORBIDDEN = /autel|permanentlock|permanent-lock/i;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'vendors' || entry.name === 'node_modules' ? [] : sourceFiles(path);
      }
      return /\.(js|ts|json)$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

test('no manufacturer is named outside the vendors/ folders', async () => {
  const files = [
    join(root, 'index.js'),
    join(root, 'gladys-assistant-integration.json'),
    ...(await sourceFiles(join(root, 'src'))),
    ...(await sourceFiles(join(root, 'gateway', 'src'))),
  ];
  assert.ok(files.length > 10, 'the scan found the sources');

  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (FORBIDDEN.test(text)) offenders.push(relative(root, file).split(sep).join('/'));
  }
  assert.deepEqual(offenders, []);
});
