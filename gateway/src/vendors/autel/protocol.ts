/**
 * Autel's wire format, as observed on a real charge point (vendor "Autel").
 *
 * The permanent connector lock is a vendor extension carried by OCPP's generic
 * `DataTransfer` (there is nothing standard behind it: OCPP 1.6 only has the
 * one-shot `UnlockConnector`):
 *
 *   CALL      DataTransfer {"vendorId":"Autel","messageId":"PermanentLockConnector",
 *                           "data":{"connectorId":1,"lock":true}}
 *   RESPONSE  {"status":"Accepted","data":"{\"status\":0}"}
 *
 * The charge point announces the feature in its `SupportedFunctionLists`
 * configuration key (a comma-separated list containing `PerManentLock`).
 *
 * Pure functions only: what talks to the charge point is index.ts.
 */

import type { DataTransferRequest, DataTransferResponse } from '../../ocpp16.ts';

export const AUTEL_VENDOR_ID = 'Autel';
export const PERMANENT_LOCK_MESSAGE_ID = 'PermanentLockConnector';
export const SUPPORTED_FUNCTIONS_KEY = 'SupportedFunctionLists';
export const PERMANENT_LOCK_FUNCTION = 'PerManentLock';

/** True for a charge point that announced itself as an Autel one. */
export function isAutel(vendor: string | null | undefined): boolean {
  return (
    typeof vendor === 'string' && vendor.trim().toLowerCase() === AUTEL_VENDOR_ID.toLowerCase()
  );
}

/** The DataTransfer CALL that locks (`true`) or unlocks (`false`) one connector. */
export function permanentLockRequest(connectorId: number, lock: boolean): DataTransferRequest {
  return {
    vendorId: AUTEL_VENDOR_ID,
    messageId: PERMANENT_LOCK_MESSAGE_ID,
    data: { connectorId, lock },
  } as DataTransferRequest;
}

/**
 * Reads a `PermanentLockConnector` exchange. Returns null for any other
 * DataTransfer, and for one the charge point did not accept: only an accepted
 * command (`Accepted` plus an inner `{"status":0}`) tells the lock really moved.
 */
export function parsePermanentLock(
  params: unknown,
  response: unknown,
): { connectorId: number; lock: boolean } | null {
  const p = params as Partial<DataTransferRequest> | undefined;
  if (p?.vendorId !== AUTEL_VENDOR_ID || p.messageId !== PERMANENT_LOCK_MESSAGE_ID) return null;

  const data = p.data as { connectorId?: unknown; lock?: unknown } | string | undefined;
  // The request payload is an object on the wire, but tolerate the string form
  // other Autel messages use.
  const payload = typeof data === 'string' ? safeJson(data) : data;
  if (
    !payload ||
    typeof payload.connectorId !== 'number' ||
    !Number.isInteger(payload.connectorId) ||
    typeof payload.lock !== 'boolean'
  ) {
    return null;
  }

  const r = response as Partial<DataTransferResponse> | undefined;
  if (r?.status !== 'Accepted') return null;
  const inner = typeof r.data === 'string' ? safeJson(r.data) : r.data;
  if ((inner as { status?: unknown } | null | undefined)?.status !== 0) return null;

  return { connectorId: payload.connectorId, lock: payload.lock };
}

/**
 * Reads a `GetConfiguration` response: does the charge point list the
 * permanent lock among its functions? Null when the response does not carry
 * `SupportedFunctionLists` at all (a different GetConfiguration), so the
 * caller leaves what it knew untouched.
 */
export function parsePermanentLockSupport(response: unknown): boolean | null {
  const keys = (response as { configurationKey?: unknown } | undefined)?.configurationKey;
  if (!Array.isArray(keys)) return null;
  const entry = keys.find(
    (item: { key?: unknown }) => item && item.key === SUPPORTED_FUNCTIONS_KEY,
  ) as { value?: unknown } | undefined;
  if (!entry || typeof entry.value !== 'string') return null;
  return entry.value
    .split(',')
    .some((fn) => fn.trim().toLowerCase() === PERMANENT_LOCK_FUNCTION.toLowerCase());
}

function safeJson(
  text: string,
): { connectorId?: unknown; lock?: unknown; status?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
