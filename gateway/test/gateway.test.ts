/**
 * End-to-end relay wiring test: a real RPCServer acting as a fake "origin
 * cloud", the relay under test (`createGatewayServer`), and real RPCClient
 * connections acting as charge points - all over localhost, no mocks. Proves
 * the response asymmetry (only the primary's response reaches the charge
 * point), multi-charge-point isolation (including routing two DIFFERENT
 * charge points to two DIFFERENT origin clouds), and that the internal state
 * observes the transactionId REALLY assigned by the primary, never invented
 * locally.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RPCClient, RPCServer } from 'ocpp-rpc';
import type { IHandlersOption } from 'ocpp-rpc';
import { createGatewayServer, store, registry } from '../src/gateway.ts';
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

function fakePrimaryServer(port: number) {
  const primaryServer = new RPCServer({ protocols: ['ocpp1.6'] });
  primaryServer.auth((accept: (session?: Record<string, unknown>) => void) => accept());
  const received = new Map<string, { method: string; params: unknown }[]>();
  const clients = new Map<string, any>();

  primaryServer.on('client', (client: any) => {
    const identity = client.identity as string;
    received.set(identity, []);
    clients.set(identity, client);

    client.handle((args: IHandlersOption) => {
      const method = args.method as string;
      received.get(identity)!.push({ method, params: args.params });
      if (method === 'BootNotification') {
        return {
          status: 'Accepted',
          interval: 300,
          currentTime: new Date().toISOString(),
          vendorNote: `primary-${port}-${identity}`,
        };
      }
      if (method === 'StartTransaction') {
        return { transactionId: PRIMARY_TRANSACTION_ID, idTagInfo: { status: 'Accepted' } };
      }
      if (method === 'StopTransaction') {
        return { idTagInfo: { status: 'Accepted' } };
      }
      return { status: 'Accepted', answeredBy: `primary-${port}-${identity}` };
    });
  });

  return { primaryServer, received, clients };
}

async function setup() {
  const {
    primaryServer,
    received: primaryReceived,
    clients: primaryClients,
  } = fakePrimaryServer(PRIMARY_PORT);
  await primaryServer.listen(PRIMARY_PORT);

  registry.replaceMap(
    Object.fromEntries(IDENTITIES.map((identity) => [identity, `ws://localhost:${PRIMARY_PORT}`])),
  );

  const gatewayServer = createGatewayServer();
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
        assert.equal(responses[i]!.vendorNote, `primary-${PRIMARY_PORT}-${identity}`);
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

test('two different charge points route to two different origin clouds', async (t) => {
  const PORT_1 = 19529;
  const PRIMARY_1_PORT = 19530;
  const PRIMARY_2_PORT = 19531;

  const primary1 = fakePrimaryServer(PRIMARY_1_PORT);
  const primary2 = fakePrimaryServer(PRIMARY_2_PORT);
  await primary1.primaryServer.listen(PRIMARY_1_PORT);
  await primary2.primaryServer.listen(PRIMARY_2_PORT);
  t.after(() => Promise.all([primary1.primaryServer.close({}), primary2.primaryServer.close({})]));

  registry.replaceMap({
    'CP-VENDOR-1': `ws://localhost:${PRIMARY_1_PORT}`,
    'CP-VENDOR-2': `ws://localhost:${PRIMARY_2_PORT}`,
  });

  const gatewayServer = createGatewayServer();
  await gatewayServer.listen(PORT_1);
  t.after(() => gatewayServer.close({}));

  const client1 = new RPCClient({
    endpoint: `ws://localhost:${PORT_1}`,
    identity: 'CP-VENDOR-1',
    protocols: ['ocpp1.6'],
  } as ClientOptions);
  const client2 = new RPCClient({
    endpoint: `ws://localhost:${PORT_1}`,
    identity: 'CP-VENDOR-2',
    protocols: ['ocpp1.6'],
  } as ClientOptions);
  await client1.connect();
  await client2.connect();
  t.after(() => Promise.all([client1.close(), client2.close()]));

  const response1 = (await client1.call('BootNotification', {
    chargePointVendor: 'v1',
    chargePointModel: 'm1',
  })) as BootNotificationResponse & {
    vendorNote?: string;
  };
  const response2 = (await client2.call('BootNotification', {
    chargePointVendor: 'v2',
    chargePointModel: 'm2',
  })) as BootNotificationResponse & {
    vendorNote?: string;
  };

  assert.equal(response1.vendorNote, `primary-${PRIMARY_1_PORT}-CP-VENDOR-1`);
  assert.equal(response2.vendorNote, `primary-${PRIMARY_2_PORT}-CP-VENDOR-2`);
});

test('an unconfigured identity is recorded as pending and closed cleanly, no crash', async (t) => {
  const PORT = 19545; // distinct from originConnectionWire.test.ts's CLOUD_PORT (files run concurrently)

  registry.replaceMap({}); // nothing configured
  const gatewayServer = createGatewayServer();
  await gatewayServer.listen(PORT);
  t.after(() => gatewayServer.close({}));

  const client = new RPCClient({
    endpoint: `ws://localhost:${PORT}`,
    identity: 'CP-UNCONFIGURED',
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as ClientOptions);
  const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
  await client.connect();
  await closed;

  const pending = registry.pendingList();
  assert.ok(pending.some((e) => e.identity === 'CP-UNCONFIGURED'));
});

test('configuring a previously-pending identity (via replaceMap) lets the next connection through', async (t) => {
  const PORT = 19533;
  const PRIMARY_PORT_LOCAL = 19534;

  const { primaryServer } = fakePrimaryServer(PRIMARY_PORT_LOCAL);
  await primaryServer.listen(PRIMARY_PORT_LOCAL);
  t.after(() => primaryServer.close({}));

  registry.replaceMap({}); // starts unconfigured
  const gatewayServer = createGatewayServer();
  await gatewayServer.listen(PORT);
  t.after(() => gatewayServer.close({}));

  const firstAttempt = new RPCClient({
    endpoint: `ws://localhost:${PORT}`,
    identity: 'CP-LATE-CONFIG',
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as ClientOptions);
  const firstClosed = new Promise<void>((resolve) => firstAttempt.once('close', () => resolve()));
  await firstAttempt.connect();
  await firstClosed;
  assert.ok(registry.pendingList().some((e) => e.identity === 'CP-LATE-CONFIG'));

  // The main container configures it live - no gateway restart needed.
  registry.replaceMap({ 'CP-LATE-CONFIG': `ws://localhost:${PRIMARY_PORT_LOCAL}` });
  assert.equal(
    registry.pendingList().some((e) => e.identity === 'CP-LATE-CONFIG'),
    false,
  );

  const secondAttempt = new RPCClient({
    endpoint: `ws://localhost:${PORT}`,
    identity: 'CP-LATE-CONFIG',
    protocols: ['ocpp1.6'],
    reconnect: false,
  } as ClientOptions);
  await secondAttempt.connect();
  t.after(() => secondAttempt.close());

  const response = (await secondAttempt.call('BootNotification', {
    chargePointVendor: 'x',
    chargePointModel: 'y',
  })) as BootNotificationResponse & {
    vendorNote?: string;
  };
  assert.equal(response.vendorNote, `primary-${PRIMARY_PORT_LOCAL}-CP-LATE-CONFIG`);
});

test('a configured but malformed origin cloud URL closes the connection cleanly, never crashes the process', async (t) => {
  const REGRESSION_GATEWAY_PORT = 19528;

  // Regression test for a real incident: originConnection.ts's guiding error
  // message ("Origin cloud URL has a query string but no empty parameter...")
  // is far longer than the 123-byte limit of a WebSocket close frame reason.
  // Left unguarded, this used to crash the whole gateway process (a RangeError
  // thrown deep inside ocpp-rpc/ws while trying to close the socket with that
  // over-long reason) instead of just rejecting the one problematic
  // connection - see gateway.ts's try/catch around buildPrimaryConnectionOptions().
  const malformedUrl = 'wss://cloud.example.com/ocpp/webSocket?sn=already-filled-in';

  registry.replaceMap({ 'CP-REGRESSION': malformedUrl, 'CP-AFTER-REGRESSION': malformedUrl });
  const gatewayServer = createGatewayServer();
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
