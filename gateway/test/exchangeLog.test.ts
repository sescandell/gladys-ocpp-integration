import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatExchangeLog } from '../src/exchangeLog.ts';

test('formats a successful exchange with timestamp, direction, params and response', () => {
  const line = formatExchangeLog(
    'EV Charger -> Primary',
    'CP-1',
    'BootNotification',
    { chargePointVendor: 'x' },
    { ok: true, response: { status: 'Accepted' } },
  );

  assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  assert.match(line, /\[EV Charger -> Primary\]/);
  assert.match(line, /\[OK\]/);
  assert.match(line, /CP-1 BootNotification/);
  assert.match(line, /params=\{"chargePointVendor":"x"\}/);
  assert.match(line, /response=\{"status":"Accepted"\}/);
});

test('formats a failed exchange with the error message, no response field', () => {
  const line = formatExchangeLog(
    'Primary -> EV Charger',
    'CP-1',
    'GetConfiguration',
    {},
    { ok: false, error: 'timeout' },
  );

  assert.match(line, /\[Primary -> EV Charger\]/);
  assert.match(line, /\[FAILED\]/);
  assert.match(line, /error=timeout/);
  assert.doesNotMatch(line, /response=/);
});
