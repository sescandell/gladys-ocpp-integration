/**
 * Synthesized "everything is fine" responses for a charge point that hasn't
 * been configured with an origin cloud yet ("local mode" - see gateway.ts).
 * No real CSMS backs these: the gateway itself answers, generically and
 * successfully, so the charge point boots, heartbeats, and reports status
 * normally - real telemetry still flows into the same StateStore relay mode
 * uses (see gateway.ts's `observe(state, method, params, response)` call
 * with THIS module's response), it just never reaches a real cloud.
 *
 * Response shapes match the real OCPP 1.6 confirmation for each message
 * (ocpp16.ts) - StatusNotification and MeterValues genuinely have an empty
 * `{}` confirmation in the spec, not an omission here.
 */

import type {
  BootNotificationResponse,
  HeartbeatResponse,
  AuthorizeResponse,
  StartTransactionResponse,
  StopTransactionResponse,
  DataTransferResponse,
} from './ocpp16.ts';

let nextTransactionId = 1;

/**
 * Locally-invented transaction ids, unique only within this gateway
 * process (resets on restart, same documented-limitation style as the rest
 * of this sub-project's in-memory state). The real origin cloud never
 * issues or recognizes these - see gateway.ts's header comment on the
 * known limitation when a charge point switches from local to relay mode
 * mid-transaction.
 */
export function nextLocalTransactionId(): number {
  return nextTransactionId++;
}

export function synthesizeLocalResponse(method: string, params: unknown): unknown {
  switch (method) {
    case 'BootNotification':
      return {
        status: 'Accepted',
        interval: 300,
        currentTime: new Date().toISOString(),
      } satisfies BootNotificationResponse;
    case 'Heartbeat':
      return { currentTime: new Date().toISOString() } satisfies HeartbeatResponse;
    case 'StatusNotification':
    case 'MeterValues':
      // Real OCPP 1.6 confirmation for both is genuinely empty.
      return {};
    case 'Authorize':
      return { idTagInfo: { status: 'Accepted' } } satisfies AuthorizeResponse;
    case 'StartTransaction':
      return {
        transactionId: nextLocalTransactionId(),
        idTagInfo: { status: 'Accepted' },
      } satisfies StartTransactionResponse;
    case 'StopTransaction':
      return { idTagInfo: { status: 'Accepted' } } satisfies StopTransactionResponse;
    case 'DataTransfer':
      // Spec-honest, not just permissive: we never actually understand a
      // vendor-specific payload locally, so 'Accepted' would falsely imply
      // we processed something - 'UnknownVendorId' says exactly what's true.
      return { status: 'UnknownVendorId' } satisfies DataTransferResponse;
    default:
      // Safe generic-success fallback for anything unlisted (matches OCPP
      // 1.6's own empty-confirmation shape for FirmwareStatusNotification,
      // DiagnosticsStatusNotification, etc.) - never leaves a CALL
      // unanswered.
      return {};
  }
}
