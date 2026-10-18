// The generic command channel, against a stand-in vendor module: it must work
// without knowing any manufacturer (the Autel module has its own tests).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createChargerCommands } from '../src/chargerCommands.ts';
import { CommandError } from '../src/commandError.ts';
import { StateStore } from '../src/state.ts';
import { createChangeFeed } from '../src/changeFeed.ts';
import type { VendorModule } from '../src/vendors/types.ts';

function setup(t: any, vendor: string | null = 'Acme') {
  const store = new StateStore();
  store.get('CP').vendor = vendor;
  const changeFeed = createChangeFeed(store, { coalesceMs: 0 });
  t.after(() => changeFeed.close());
  const changes: string[] = [];
  changeFeed.subscribe((change) => changes.push(change.identity));

  const call = mock.fn(async (_method: string, _params?: unknown, _options?: object) => ({
    ok: true,
  }));
  const liveClients = new Map([['CP', { call }]]);
  const toggle = mock.fn(async (context: any, { connectorId, value }: any) => {
    const reply = await context.call('Echo', { connectorId, value });
    context.state.extension('acme').connectors[connectorId] = { toggled: value, reply };
  });
  const probe = mock.fn(async (context: any) => {
    await context.call('Hello', {});
    context.state.extension('acme').supported = true;
  });
  const acme: VendorModule = {
    id: 'acme',
    matches: (state) => state.vendor === 'Acme',
    probe,
    commands: { toggle },
  };
  return {
    store,
    changes,
    call,
    liveClients,
    toggle,
    probe,
    commands: createChargerCommands(store, liveClients, changeFeed, [acme]),
  };
}

test('run hands the command to the module that applies, then signals the change', async (t) => {
  const { store, changes, call, commands } = setup(t);

  await commands.run('CP', 2, 'toggle', true);

  assert.deepEqual(call.mock.calls[0].arguments.slice(0, 2), [
    'Echo',
    { connectorId: 2, value: true },
  ]);
  assert.equal(store.get('CP').extension('acme').connectors[2]!.toggled, true);
  assert.deepEqual(changes, ['CP']);
});

test('run: a charge point that is not connected answers 409 and nothing is sent', async (t) => {
  const { commands, liveClients, call } = setup(t);
  liveClients.clear();
  await assert.rejects(
    commands.run('CP', 1, 'toggle', true),
    (err: CommandError) => err.status === 409,
  );
  assert.equal(call.mock.callCount(), 0);
});

test('run: unknown command is 404, a command another vendor offers is 422', async (t) => {
  const { commands, toggle } = setup(t);
  await assert.rejects(
    commands.run('CP', 1, 'nonsense', true),
    (err: CommandError) => err.status === 404,
  );
  // Object.prototype names are not commands.
  await assert.rejects(
    commands.run('CP', 1, 'constructor', true),
    (err: CommandError) => err.status === 404,
  );

  const other = setup(t, 'Wallbox');
  await assert.rejects(
    other.commands.run('CP', 1, 'toggle', true),
    (err: CommandError) => err.status === 422,
  );
  assert.equal(toggle.mock.callCount(), 0);
  assert.equal(other.toggle.mock.callCount(), 0);
});

test('the context call turns a failure into a 502 carrying the reason', async (t) => {
  const { commands, call } = setup(t);
  call.mock.mockImplementation(async () => {
    throw new Error('timeout');
  });
  await assert.rejects(
    commands.run('CP', 1, 'toggle', true),
    (err: CommandError) => err.status === 502 && /timeout/.test(err.message),
  );
});

test('probe runs the modules that apply and signals the change', async (t) => {
  const { store, changes, probe, commands } = setup(t);
  await commands.probe('CP');
  assert.equal(probe.mock.callCount(), 1);
  assert.equal(store.get('CP').extension('acme').supported, true);
  assert.deepEqual(changes, ['CP']);
});

test('probe skips other vendors, a charge point that left, and survives a failing module', async (t) => {
  const other = setup(t, 'Wallbox');
  await other.commands.probe('CP');
  assert.equal(other.probe.mock.callCount(), 0);

  const gone = setup(t);
  gone.liveClients.clear();
  await gone.commands.probe('CP'); // resolves, no throw
  assert.equal(gone.probe.mock.callCount(), 0);

  const failing = setup(t);
  failing.call.mock.mockImplementation(async () => {
    throw new Error('no answer');
  });
  await failing.commands.probe('CP'); // resolves, the failure is only logged
  assert.equal(failing.store.get('CP').extension('acme').supported, false);
});
