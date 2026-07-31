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
