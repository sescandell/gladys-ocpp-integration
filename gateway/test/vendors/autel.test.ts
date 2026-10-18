import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAutel,
  parsePermanentLock,
  parsePermanentLockSupport,
  permanentLockRequest,
} from '../../src/vendors/autel/protocol.ts';
import { autel } from '../../src/vendors/autel/index.ts';
import { observeOutgoing } from '../../src/observe.ts';
import { ChargerState } from '../../src/state.ts';
import { CommandError } from '../../src/commandError.ts';
import type { VendorContext } from '../../src/vendors/types.ts';

// What a real Autel charge point exchanged when the vendor's app locked it.
const REAL_REQUEST = {
  data: { connectorId: 1, lock: true },
  messageId: 'PermanentLockConnector',
  vendorId: 'Autel',
};
const REAL_RESPONSE = { data: '{"status":0}', status: 'Accepted' };

// The relevant slice of the real GetConfiguration answer.
const CONFIGURATION_WITH_LOCK = {
  configurationKey: [
    { key: 'LedLightBrightness', readonly: false, value: '0' },
    {
      key: 'SupportedFunctionLists',
      readonly: true,
      value: 'WIFI,Ethernet,GroudingType,MaxCurrent,TimeCharging,PerManentLock,WiSun,RS485,CT',
    },
  ],
};

function autelState(): ChargerState {
  const state = new ChargerState('CP');
  state.vendor = 'Autel';
  return state;
}

const lockOf = (state: ChargerState, connectorId = 1) =>
  state.extension('autel').connectors[connectorId]?.permanentLock;

// --- Protocol -------------------------------------------------------------------

test('isAutel matches the announced vendor regardless of case and spaces', () => {
  assert.equal(isAutel('Autel'), true);
  assert.equal(isAutel(' autel '), true);
  assert.equal(isAutel('Wallbox'), false);
  assert.equal(isAutel(null), false);
});

test('permanentLockRequest builds the exact payload the vendor app sends', () => {
  assert.deepEqual(permanentLockRequest(1, true), REAL_REQUEST);
  assert.deepEqual(permanentLockRequest(2, false).data, { connectorId: 2, lock: false });
});

test('parsePermanentLock reads the real exchange', () => {
  assert.deepEqual(parsePermanentLock(REAL_REQUEST, REAL_RESPONSE), { connectorId: 1, lock: true });
});

test('parsePermanentLock ignores other DataTransfers and refused or odd answers', () => {
  const other = { vendorId: 'Autel', messageId: 'GetAPPRequiredConfig' };
  assert.equal(parsePermanentLock(other, REAL_RESPONSE), null);
  assert.equal(parsePermanentLock({ ...REAL_REQUEST, vendorId: 'Other' }, REAL_RESPONSE), null);
  assert.equal(parsePermanentLock(REAL_REQUEST, { status: 'Rejected' }), null);
  assert.equal(
    parsePermanentLock(REAL_REQUEST, { status: 'Accepted', data: '{"status":1}' }),
    null,
  );
  assert.equal(parsePermanentLock(REAL_REQUEST, { status: 'Accepted', data: 'nope' }), null);
  assert.equal(parsePermanentLock(REAL_REQUEST, undefined), null);
  assert.equal(
    parsePermanentLock({ ...REAL_REQUEST, data: { connectorId: 1, lock: 'yes' } }, REAL_RESPONSE),
    null,
  );
});

test('parsePermanentLockSupport reads the function list of a GetConfiguration answer', () => {
  assert.equal(parsePermanentLockSupport(CONFIGURATION_WITH_LOCK), true);
  assert.equal(
    parsePermanentLockSupport({
      configurationKey: [{ key: 'SupportedFunctionLists', value: 'WIFI,Ethernet' }],
    }),
    false,
  );
  // Another GetConfiguration, or garbage: says nothing, the caller keeps what it knew.
  assert.equal(parsePermanentLockSupport({ configurationKey: [] }), null);
  assert.equal(parsePermanentLockSupport({}), null);
  assert.equal(parsePermanentLockSupport(undefined), null);
});

// --- Module -----------------------------------------------------------------------

test('the module applies to Autel charge points only', () => {
  assert.equal(autel.matches(autelState()), true);
  const other = new ChargerState('CP');
  other.vendor = 'Wallbox';
  assert.equal(autel.matches(other), false);
});

test('an accepted lock command sets the connector state (and proves support), the last one wins', () => {
  const state = autelState();
  assert.equal(state.extension('autel').supported, false);
  assert.equal(lockOf(state), undefined);

  observeOutgoing(state, 'DataTransfer', REAL_REQUEST, REAL_RESPONSE);
  assert.equal(lockOf(state), true);
  assert.equal(state.extension('autel').supported, true);

  observeOutgoing(state, 'DataTransfer', permanentLockRequest(1, false), REAL_RESPONSE);
  assert.equal(lockOf(state), false);
});

test('a refused lock command leaves the state alone', () => {
  const state = autelState();
  observeOutgoing(state, 'DataTransfer', REAL_REQUEST, { status: 'Rejected' });
  assert.equal(lockOf(state), undefined);
  assert.equal(state.extension('autel').supported, false);
});

test('the cloud asking for the configuration tells whether the lock is supported', () => {
  const state = autelState();
  observeOutgoing(state, 'GetConfiguration', {}, CONFIGURATION_WITH_LOCK);
  assert.equal(state.extension('autel').supported, true);
  observeOutgoing(state, 'GetConfiguration', {}, { configurationKey: [] });
  assert.equal(state.extension('autel').supported, true); // unrelated answer: untouched
});

test('nothing is observed on a charge point of another vendor, nor for other calls', () => {
  const other = new ChargerState('CP');
  other.vendor = 'Wallbox';
  observeOutgoing(other, 'DataTransfer', REAL_REQUEST, REAL_RESPONSE);
  assert.equal(other.extensions.size, 0);

  const state = autelState();
  observeOutgoing(state, 'Reset', { type: 'Soft' }, { status: 'Accepted' });
  assert.equal(state.extensions.size, 0);
});

function context(state: ChargerState, response: unknown): VendorContext & { call: any } {
  return { identity: 'CP', state, call: mock.fn(async () => response) };
}

test('probe records what the charge point says it supports', async () => {
  const supporting = context(autelState(), CONFIGURATION_WITH_LOCK);
  await autel.probe!(supporting);
  assert.deepEqual(supporting.call.mock.calls[0].arguments, [
    'GetConfiguration',
    { key: ['SupportedFunctionLists'] },
  ]);
  assert.equal(supporting.state.extension('autel').supported, true);

  const without = context(autelState(), {
    configurationKey: [{ key: 'SupportedFunctionLists', value: 'WIFI' }],
  });
  await autel.probe!(without);
  assert.equal(without.state.extension('autel').supported, false);
});

test('the permanent-lock command needs support, a boolean, and an accepted answer', async () => {
  const command = autel.commands!['permanent-lock']!;

  const unsupported = context(autelState(), REAL_RESPONSE);
  await assert.rejects(
    command(unsupported, { connectorId: 1, value: true }),
    (err: CommandError) => err.status === 422,
  );
  assert.equal(unsupported.call.mock.callCount(), 0);

  const state = autelState();
  state.extension('autel').supported = true;
  await assert.rejects(
    command(context(state, REAL_RESPONSE), { connectorId: 1, value: 'yes' }),
    (err: CommandError) => err.status === 400,
  );

  await assert.rejects(
    command(context(state, { status: 'Rejected' }), { connectorId: 1, value: true }),
    (err: CommandError) => err.status === 502,
  );
  assert.equal(lockOf(state), undefined);

  const ok = context(state, REAL_RESPONSE);
  await command(ok, { connectorId: 1, value: true });
  assert.deepEqual(ok.call.mock.calls[0].arguments, ['DataTransfer', REAL_REQUEST]);
  assert.equal(lockOf(state), true);
});
