import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeLocalResponse } from '../src/localMode.ts';

test('BootNotification: Accepted, with a currentTime and a numeric interval', () => {
  const response = synthesizeLocalResponse('BootNotification', {}) as {
    status: string;
    interval: number;
    currentTime: string;
  };
  assert.equal(response.status, 'Accepted');
  assert.equal(typeof response.interval, 'number');
  assert.ok(!Number.isNaN(Date.parse(response.currentTime)));
});

test('Heartbeat: a currentTime only', () => {
  const response = synthesizeLocalResponse('Heartbeat', {}) as { currentTime: string };
  assert.ok(!Number.isNaN(Date.parse(response.currentTime)));
});

test('StatusNotification and MeterValues: genuinely empty confirmation (matches OCPP 1.6)', () => {
  assert.deepEqual(synthesizeLocalResponse('StatusNotification', {}), {});
  assert.deepEqual(synthesizeLocalResponse('MeterValues', {}), {});
});

test('Authorize: idTagInfo Accepted', () => {
  assert.deepEqual(synthesizeLocalResponse('Authorize', {}), { idTagInfo: { status: 'Accepted' } });
});

test('StartTransaction: a numeric transactionId, strictly increasing across calls', () => {
  const first = synthesizeLocalResponse('StartTransaction', {}) as {
    transactionId: number;
    idTagInfo: { status: string };
  };
  const second = synthesizeLocalResponse('StartTransaction', {}) as { transactionId: number };
  assert.equal(typeof first.transactionId, 'number');
  assert.equal(first.idTagInfo.status, 'Accepted');
  assert.ok(second.transactionId > first.transactionId);
});

test('StopTransaction: idTagInfo Accepted', () => {
  assert.deepEqual(synthesizeLocalResponse('StopTransaction', {}), {
    idTagInfo: { status: 'Accepted' },
  });
});

test('DataTransfer: UnknownVendorId (spec-honest, not a blanket Accepted)', () => {
  assert.deepEqual(synthesizeLocalResponse('DataTransfer', {}), { status: 'UnknownVendorId' });
});

test('an unlisted method returns an empty confirmation rather than being left unanswered', () => {
  assert.deepEqual(synthesizeLocalResponse('FirmwareStatusNotification', {}), {});
  assert.deepEqual(synthesizeLocalResponse('SomeFutureOcppMessage', {}), {});
});
