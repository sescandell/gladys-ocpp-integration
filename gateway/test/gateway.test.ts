/**
 * End-to-end relay wiring test: a real RPCServer acting as a fake "origin
 * cloud", the relay under test (`createGatewayServer`), and real RPCClient
 * connections acting as charge points - all over localhost, no mocks. Proves
 * the response asymmetry (only the primary's response reaches the charge
 * point), multi-charge-point isolation, and that the internal state observes
 * the transactionId REALLY assigned by the primary, never invented locally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPCClient, RPCServer } from 'ocpp-rpc';
import type { IHandlersOption } from 'ocpp-rpc';
import { createGatewayServer, store } from '../src/gateway.ts';
import type {
  BootNotificationResponse,
  StartTransactionResponse,
  StopTransactionResponse,
} from '../src/ocpp16.ts';

const GATEWAY_PORT = 19526;
const PRIMARY_PORT = 19527;
const IDENTITIES = ['CP-A', 'CP-B', 'CP-C'] as const;

// The fake primary assigns a distinctive transactionId, very different from
// a local `Math.floor(Date.now()/1000)`-style guess, to prove unambiguously
// that the observed state comes from IT and not from a local computation.
const PRIMARY_TRANSACTION_ID = 987654;

type ClientOptions = ConstructorParameters<typeof RPCClient>[0];

async function setup() {
  // Fake primary (origin cloud): answers identifiably, keeps track of
  // received calls and a reference to each server-side client to push a
  // targeted CALL later.
  const primaryServer = new RPCServer({ protocols: ['ocpp1.6'] });
  primaryServer.auth((accept: (session?: Record<string, unknown>) => void) => accept());
  const primaryReceived = new Map<string, { method: string; params: unknown }[]>();
  const primaryClients = new Map<string, any>();

  primaryServer.on('client', (client: any) => {
    const identity = client.identity as string;
    primaryReceived.set(identity, []);
    primaryClients.set(identity, client);

    client.handle((args: IHandlersOption) => {
      const method = args.method as string;
      primaryReceived.get(identity)!.push({ method, params: args.params });
      if (method === 'BootNotification') {
        return {
          status: 'Accepted',
          interval: 300,
          currentTime: new Date().toISOString(),
          vendorNote: `primary-${identity}`,
        };
      }
      if (method === 'StartTransaction') {
        return { transactionId: PRIMARY_TRANSACTION_ID, idTagInfo: { status: 'Accepted' } };
      }
      if (method === 'StopTransaction') {
        return { idTagInfo: { status: 'Accepted' } };
      }
      return { status: 'Accepted', answeredBy: `primary-${identity}` };
    });
  });
  await primaryServer.listen(PRIMARY_PORT);

  const gatewayServer = createGatewayServer({
    buildPrimaryConnection: (identity) => ({
      endpoint: `ws://localhost:${PRIMARY_PORT}`,
      identity,
    }),
  });
  await gatewayServer.listen(GATEWAY_PORT);

  const chargerClients = new Map<string, RPCClient>();
  const chargerReceived = new Map<string, { method: string; params: unknown }[]>();

  for (const identity of IDENTITIES) {
    const cli = new RPCClient({
      endpoint: `ws://localhost:${GATEWAY_PORT}`,
      identity,
      protocols: ['ocpp1.6'],
    } as ClientOptions);
    chargerReceived.set(identity, []);
    cli.handle(async (args: IHandlersOption) => {
      const method = args.method as string;
      chargerReceived.get(identity)!.push({ method, params: args.params });
      return { status: 'Accepted', answeredBy: identity };
    });
    await cli.connect();
    chargerClients.set(identity, cli);
  }

  async function teardown() {
    for (const cli of chargerClients.values()) {
      await cli.close();
    }
    await gatewayServer.close({});
    await primaryServer.close({});
  }

  return { chargerClients, chargerReceived, primaryClients, teardown };
}

test('gateway relay: end to end wiring', async (t) => {
  const { chargerClients, chargerReceived, primaryClients, teardown } = await setup();
  t.after(teardown);

  await t.test(
    'BootNotification on every charge point returns the PRIMARY response, no cross-talk',
    async () => {
      const responses = await Promise.all(
        IDENTITIES.map(
          (identity) =>
            chargerClients.get(identity)!.call('BootNotification', {
              chargePointVendor: 'test',
              chargePointModel: `gateway-test-${identity}`,
            }) as Promise<BootNotificationResponse & { vendorNote?: string }>,
        ),
      );
      IDENTITIES.forEach((identity, i) => {
        assert.equal(responses[i]!.vendorNote, `primary-${identity}`);
      });
    },
  );

  await t.test(
    "StartTransaction: the transactionId returned to the charge point is the PRIMARY's, never invented",
    async () => {
      const start = (await chargerClients.get('CP-B')!.call('StartTransaction', {
        connectorId: 1,
        idTag: 'test-tag',
        meterStart: 500,
        timestamp: new Date().toISOString(),
      })) as StartTransactionResponse;

      assert.equal(start.transactionId, PRIMARY_TRANSACTION_ID);

      const connector = store.get('CP-B').connector(1);
      assert.equal(connector.transactionId, PRIMARY_TRANSACTION_ID);
      assert.equal(connector.idTag, 'test-tag');
      assert.equal(connector.energyActiveImportRegisterWh, 500);

      // The other charge points are unaffected by CP-B's transaction.
      assert.equal(store.get('CP-A').connector(1).transactionId, null);
      assert.equal(store.get('CP-C').connector(1).transactionId, null);
    },
  );

  await t.test('StopTransaction: archived in history with the PRIMARY transactionId', async () => {
    const stop = (await chargerClients.get('CP-B')!.call('StopTransaction', {
      transactionId: PRIMARY_TRANSACTION_ID,
      meterStop: 750,
      timestamp: new Date().toISOString(),
      reason: 'Local',
    })) as StopTransactionResponse;

    assert.equal(stop.idTagInfo?.status, 'Accepted');
    const charger = store.get('CP-B');
    assert.equal(charger.connector(1).transactionId, null);
    assert.equal(charger.history[0]?.transactionId, PRIMARY_TRANSACTION_ID);
    assert.equal(charger.history[0]?.meterStop, 750);
  });

  await t.test(
    'a CALL initiated by the primary, targeted at one charge point, only reaches that one',
    async () => {
      const pushResult = (await primaryClients.get('CP-C').call('DataTransfer', {
        vendorId: 'gateway-test',
        messageId: 'ping-C-only',
      })) as { answeredBy: string };

      assert.equal(pushResult.answeredBy, 'CP-C');
      assert.equal(
        chargerReceived.get('CP-C')!.some((c) => c.method === 'DataTransfer'),
        true,
      );
      assert.equal(
        chargerReceived.get('CP-A')!.some((c) => c.method === 'DataTransfer'),
        false,
      );
      assert.equal(
        chargerReceived.get('CP-B')!.some((c) => c.method === 'DataTransfer'),
        false,
      );
    },
  );
});

test('a synchronous error from buildPrimaryConnection() closes the connection cleanly, never crashes the process', async (t) => {
  const REGRESSION_GATEWAY_PORT = 19528;

  // Regression test for a real incident: originConnection.ts's guiding error
  // message ("Origin cloud URL has a query string but no empty parameter...")
  // is far longer than the 123-byte limit of a WebSocket close frame reason.
  // Left unguarded, this used to crash the whole gateway process (a RangeError
  // thrown deep inside ocpp-rpc/ws while trying to close the socket with that
  // over-long reason) instead of just rejecting the one problematic
  // connection - see gateway.ts's try/catch around buildPrimaryConnection().
  const longMessage =
    'Origin cloud URL has a query string but no empty parameter to receive the charge point identity (expected something like "...?sn=") - paste the URL exactly as shown by the vendor app.';
  assert.ok(
    Buffer.byteLength(longMessage, 'utf8') > 123,
    'the test fixture must reproduce the over-123-byte condition',
  );

  const gatewayServer = createGatewayServer({
    buildPrimaryConnection: () => {
      throw new Error(longMessage);
    },
  });
  await gatewayServer.listen(REGRESSION_GATEWAY_PORT);
  t.after(() => gatewayServer.close({}));

  // `reconnect: false`: the default `ocpp-rpc` RPCClient behavior is to
  // silently retry forever on a server-initiated close (never emitting
  // 'close' at all - see client.js's _handleDisconnect) - appropriate
  // resilience for a real charge point, but it would make this test hang
  // waiting for an event that never fires. Disabled here purely to observe
  // one clean close.
  const client = new RPCClient({
    endpoint: `ws://localhost:${REGRESSION_GATEWAY_PORT}`,
    identity: 'CP-REGRESSION',
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as ClientOptions);

  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  await client.connect();
  await closed; // would hang/time out if the server crashed instead of closing cleanly

  // The server is still alive afterward - proof the PROCESS survived, not
  // just that this one client got a clean close. A second, unrelated
  // connection attempt goes through the same (still-throwing, by this test's
  // setup) code path and is itself cleanly closed rather than hanging or
  // taking the whole server down with it.
  const secondClient = new RPCClient({
    endpoint: `ws://localhost:${REGRESSION_GATEWAY_PORT}`,
    identity: 'CP-AFTER-REGRESSION',
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as ClientOptions);
  const secondClosed = new Promise<void>((resolve) => secondClient.once('close', () => resolve()));
  await secondClient.connect();
  await secondClosed;
});
