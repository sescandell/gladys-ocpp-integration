import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChargerState } from '../src/state.ts';
import { observe } from '../src/observe.ts';

test('BootNotification records vendor/model/firmware', () => {
  const state = new ChargerState('CP-1');
  observe(
    state,
    'BootNotification',
    { chargePointVendor: 'Acme', chargePointModel: 'X1', firmwareVersion: '1.2.3' },
    { status: 'Accepted', interval: 300, currentTime: '2026-08-01T10:00:00.000Z' },
  );
  assert.equal(state.vendor, 'Acme');
  assert.equal(state.model, 'X1');
  assert.equal(state.firmwareVersion, '1.2.3');
});

test('StatusNotification for a never-seen connector id creates it dynamically', () => {
  const state = new ChargerState('CP-1');
  assert.equal(state.connectors.size, 0);

  observe(
    state,
    'StatusNotification',
    { connectorId: 1, status: 'Available', errorCode: 'NoError' },
    {},
  );
  assert.deepEqual([...state.connectors.keys()], [1]);

  observe(
    state,
    'StatusNotification',
    { connectorId: 2, status: 'Preparing', errorCode: 'NoError' },
    {},
  );
  assert.deepEqual([...state.connectors.keys()].sort(), [1, 2]);
  assert.equal(state.connector(1).status, 'Available');
  assert.equal(state.connector(2).status, 'Preparing');
});

test('MeterValues patches the right connector via meterValuesToPatch', () => {
  const state = new ChargerState('CP-1');
  observe(
    state,
    'MeterValues',
    {
      connectorId: 1,
      meterValue: [
        {
          timestamp: '2026-08-01T10:00:00.000Z',
          sampledValue: [{ value: '230', measurand: 'Voltage' }],
        },
      ],
    },
    {},
  );
  assert.equal(state.connector(1).voltageV, 230);
});

test('StartTransaction without a primary response is not observed (no reliable transactionId)', () => {
  const state = new ChargerState('CP-1');
  observe(
    state,
    'StartTransaction',
    { connectorId: 1, idTag: 'tag-1', meterStart: 0, timestamp: '2026-08-01T10:00:00.000Z' },
    undefined,
  );
  assert.equal(state.transactions.size, 0);
});

test('full sequence: Boot -> Status(1) -> Status(2) -> MeterValues -> Start -> Stop, proving dynamic multi-connector discovery end to end', () => {
  const state = new ChargerState('CP-1');

  observe(state, 'BootNotification', { chargePointVendor: 'Acme', chargePointModel: 'X1' }, {});
  observe(
    state,
    'StatusNotification',
    { connectorId: 1, status: 'Available', errorCode: 'NoError' },
    {},
  );
  observe(
    state,
    'StatusNotification',
    { connectorId: 2, status: 'Available', errorCode: 'NoError' },
    {},
  );

  assert.deepEqual([...state.connectors.keys()].sort(), [1, 2]);

  observe(
    state,
    'MeterValues',
    {
      connectorId: 1,
      meterValue: [
        {
          timestamp: '2026-08-01T10:01:00.000Z',
          sampledValue: [{ value: '1000', measurand: 'Energy.Active.Import.Register' }],
        },
      ],
    },
    {},
  );

  observe(
    state,
    'StartTransaction',
    { connectorId: 1, idTag: 'tag-1', meterStart: 1000, timestamp: '2026-08-01T10:02:00.000Z' },
    { transactionId: 77, idTagInfo: { status: 'Accepted' } },
  );
  assert.equal(state.connector(1).transactionId, 77);
  assert.equal(state.transactions.size, 1);

  observe(
    state,
    'StopTransaction',
    { transactionId: 77, meterStop: 1500, timestamp: '2026-08-01T11:00:00.000Z', reason: 'Local' },
    { idTagInfo: { status: 'Accepted' } },
  );
  assert.equal(state.transactions.size, 0);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].meterStop, 1500);
  assert.equal(state.connector(1).transactionId, null);

  // Connector 2 was only ever touched by StatusNotification - untouched by
  // the transaction on connector 1, still tracked independently.
  assert.equal(state.connector(2).status, 'Available');
  assert.equal(state.connector(2).transactionId, null);
});
