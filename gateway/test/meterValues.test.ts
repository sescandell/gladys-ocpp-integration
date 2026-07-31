import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meterValuesToPatch } from '../src/meterValues.ts';

test('maps known measurands onto their ConnectorState field', () => {
  const patch = meterValuesToPatch([
    {
      timestamp: '2026-08-01T10:00:00.000Z',
      sampledValue: [
        { value: '1234.5', measurand: 'Energy.Active.Import.Register' },
        { value: '7.2', measurand: 'Power.Active.Import' },
        { value: '16', measurand: 'Current.Import' },
        { value: '230', measurand: 'Voltage' },
      ],
    },
  ]);
  assert.equal(patch.energyActiveImportRegisterWh, 1234.5);
  assert.equal(patch.powerActiveImportW, 7.2);
  assert.equal(patch.currentImportA, 16);
  assert.equal(patch.voltageV, 230);
  assert.equal(patch.lastMeterValueAt, '2026-08-01T10:00:00.000Z');
});

test('ignores unknown measurands', () => {
  const patch = meterValuesToPatch([
    {
      timestamp: '2026-08-01T10:00:00.000Z',
      sampledValue: [{ value: '42', measurand: 'SoC' }],
    },
  ]);
  assert.deepEqual(patch, { lastMeterValueAt: '2026-08-01T10:00:00.000Z' });
});

test('ignores non-numeric values', () => {
  const patch = meterValuesToPatch([
    {
      timestamp: '2026-08-01T10:00:00.000Z',
      sampledValue: [{ value: 'not-a-number', measurand: 'Voltage' }],
    },
  ]);
  assert.equal(patch.voltageV, undefined);
});

test('handles multiple buckets, keeping the last timestamp', () => {
  const patch = meterValuesToPatch([
    {
      timestamp: '2026-08-01T10:00:00.000Z',
      sampledValue: [{ value: '10', measurand: 'Current.Import' }],
    },
    {
      timestamp: '2026-08-01T10:05:00.000Z',
      sampledValue: [{ value: '12', measurand: 'Current.Import' }],
    },
  ]);
  assert.equal(patch.currentImportA, 12);
  assert.equal(patch.lastMeterValueAt, '2026-08-01T10:05:00.000Z');
});

test('handles an undefined/empty meterValue array', () => {
  assert.deepEqual(meterValuesToPatch(undefined), {});
  assert.deepEqual(meterValuesToPatch([]), {});
});
