// -----------------------------------------------------------------------------
// The outbound state queue is what stands between the gateway's change stream
// and Gladys's hard limits (100 states/request, 300 states/minute per
// integration, TooManyRequests past that - see src/stateSync.js). These tests
// pin the behaviours the limits demand, since exceeding them in production
// silently stops every value from updating.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatePublisher } from '../src/stateSync.js';

function state(featureId, value) {
  return { device_feature_external_id: featureId, state: value };
}

/** Lets queued async flushes settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function recorder() {
  const batches = [];
  return {
    batches,
    publishStates: async (states) => {
      batches.push(states);
    },
  };
}

test('publishes what it is given', async () => {
  const { batches, publishStates } = recorder();
  const publisher = createStatePublisher({ publishStates });

  publisher.enqueue([state('f1', 1), state('f2', 2)]);
  await settle();

  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].map((s) => s.device_feature_external_id),
    ['f1', 'f2'],
  );
});

test('a value already published is not sent again', async () => {
  // A connector status barely ever changes while meter values pour in: without
  // this, every single MeterValues would spend budget republishing "Charging".
  const { batches, publishStates } = recorder();
  const publisher = createStatePublisher({ publishStates });

  publisher.enqueue([state('f1', 1)]);
  await settle();
  publisher.enqueue([state('f1', 1)]);
  await settle();

  assert.equal(batches.length, 1);

  publisher.enqueue([state('f1', 2)]);
  await settle();
  assert.equal(batches.length, 2);
  assert.equal(batches[1][0].state, 2);
});

test('a value superseded before it could be sent is dropped, last one wins', async () => {
  const publishCalls = [];
  let release;
  const publisher = createStatePublisher({
    publishStates: async (states) => {
      publishCalls.push(states);
      if (publishCalls.length === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    },
  });

  publisher.enqueue([state('f1', 1)]);
  await settle();
  // First publish is in flight: these two queue up behind it.
  publisher.enqueue([state('f2', 10)]);
  publisher.enqueue([state('f2', 20)]);
  release();
  await settle();
  await settle();

  assert.equal(publishCalls.length, 2);
  assert.deepEqual(publishCalls[1], [state('f2', 20)]);
});

test('never sends more than 100 states in one request', async () => {
  const { batches, publishStates } = recorder();
  const publisher = createStatePublisher({ publishStates });

  publisher.enqueue(Array.from({ length: 250 }, (_, i) => state(`f${i}`, i)));
  for (let i = 0; i < 5; i += 1) await settle();

  assert.deepEqual(
    batches.map((b) => b.length),
    [100, 100, 50],
  );
});

test('stops at 300 states per minute and drains when the window resets', async () => {
  const { batches, publishStates } = recorder();
  let clock = 0;
  const publisher = createStatePublisher({ publishStates, now: () => clock });

  publisher.enqueue(Array.from({ length: 400 }, (_, i) => state(`f${i}`, i)));
  for (let i = 0; i < 10; i += 1) await settle();

  assert.equal(
    batches.reduce((total, b) => total + b.length, 0),
    300,
  );
  assert.equal(publisher.pendingCount, 100, 'the rest is held, not dropped');

  // Next minute: the held states go out.
  clock += 60_001;
  publisher.enqueue([state('trigger', 1)]);
  for (let i = 0; i < 5; i += 1) await settle();

  assert.equal(publisher.pendingCount, 0);
  publisher.stop();
});

test('a failed publish is requeued, not lost', async () => {
  let attempts = 0;
  const batches = [];
  let clock = 0;
  const publisher = createStatePublisher({
    now: () => clock,
    publishStates: async (states) => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      batches.push(states);
    },
  });

  publisher.enqueue([state('f1', 1)]);
  await settle();
  assert.equal(batches.length, 0);
  assert.equal(publisher.pendingCount, 1);

  // Past the retry backoff, the next enqueue drains it.
  clock += 10_000;
  publisher.enqueue([state('f2', 2)]);
  for (let i = 0; i < 3; i += 1) await settle();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map((s) => s.device_feature_external_id).sort(), ['f1', 'f2']);
  publisher.stop();
});

test('a rate-limit rejection holds the queue for a full window', async () => {
  const batches = [];
  let clock = 0;
  let failing = true;
  const publisher = createStatePublisher({
    now: () => clock,
    publishStates: async (states) => {
      if (failing) {
        const err = new Error('RATE_LIMIT_EXCEEDED: max 300 states per minute');
        err.status = 429;
        throw err;
      }
      batches.push(states);
    },
  });

  publisher.enqueue([state('f1', 1)]);
  await settle();
  failing = false;

  // Still inside the hold: nothing goes out.
  clock += 30_000;
  publisher.enqueue([state('f2', 2)]);
  await settle();
  assert.equal(batches.length, 0);

  clock += 31_000;
  publisher.enqueue([state('f3', 3)]);
  for (let i = 0; i < 3; i += 1) await settle();
  assert.equal(batches.length, 1);
  publisher.stop();
});

test('stop() drops the queue and ignores later work', async () => {
  const { batches, publishStates } = recorder();
  const publisher = createStatePublisher({ publishStates });

  publisher.stop();
  publisher.enqueue([state('f1', 1)]);
  await settle();

  assert.equal(batches.length, 0);
  assert.equal(publisher.pendingCount, 0);
});
