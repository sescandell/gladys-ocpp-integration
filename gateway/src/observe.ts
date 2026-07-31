import type { ChargerState } from './state.ts';
import { meterValuesToPatch } from './meterValues.ts';
import type {
  BootNotificationRequest,
  StatusNotificationRequest,
  MeterValuesRequest,
  StartTransactionRequest,
  StartTransactionResponse,
  StopTransactionRequest,
} from './ocpp16.ts';

/**
 * Updates the internal state from an (OCPP CALL from the charge point,
 * response from the primary/origin cloud) pair that has already been
 * relayed. Returns nothing to the charge point: this is pure observation,
 * never a decision - see `gateway.ts`'s header comment. `response` is absent
 * when the primary call failed or timed out.
 *
 * This is where dynamic multi-connector discovery actually happens:
 * `StatusNotification` for a connector id never seen before creates a new
 * entry in `state.connectors` (see `ChargerState.connector()` /
 * `patchConnector()` in `state.ts`) - no connector count is assumed anywhere.
 */
export function observe(
  state: ChargerState,
  method: string,
  params: unknown,
  response: unknown,
): void {
  switch (method) {
    case 'BootNotification': {
      const p = params as BootNotificationRequest;
      state.vendor = p.chargePointVendor ?? state.vendor;
      state.model = p.chargePointModel ?? state.model;
      state.firmwareVersion = p.firmwareVersion ?? state.firmwareVersion;
      break;
    }
    case 'StatusNotification': {
      const p = params as StatusNotificationRequest;
      state.patchConnector(p.connectorId, {
        status: p.status,
        errorCode: p.errorCode ?? null,
        lastStatusAt: p.timestamp ?? new Date().toISOString(),
      });
      break;
    }
    case 'MeterValues': {
      const p = params as MeterValuesRequest;
      state.patchConnector(p.connectorId, meterValuesToPatch(p.meterValue));
      break;
    }
    case 'StartTransaction': {
      // No reliable transactionId to observe without a response from the primary.
      if (!response) break;
      const p = params as StartTransactionRequest;
      const r = response as StartTransactionResponse;
      state.startTransaction(p.connectorId, r.transactionId, p.idTag, p.meterStart, p.timestamp);
      break;
    }
    case 'StopTransaction': {
      // transactionId comes from the charge point, which itself got it from
      // the primary at Start time: observable even if this Stop call to the
      // primary fails/times out.
      const p = params as StopTransactionRequest;
      state.stopTransaction(p.transactionId, p.meterStop, p.timestamp, p.reason ?? null);
      break;
    }
    default:
      break;
  }
}
