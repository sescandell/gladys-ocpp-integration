/**
 * Minimal types for the subset of OCPP 1.6J messages this relay observes.
 * `ocpp-rpc` does not type message payloads (`params: Record<string, any>`) -
 * these interfaces fill that gap for the messages we actually parse.
 *
 * Pure TypeScript types (erased at runtime, zero impact on behavior): import
 * with `import type { ... } from "./ocpp16.ts"`.
 */

export interface BootNotificationRequest {
  chargePointVendor: string;
  chargePointModel: string;
  chargePointSerialNumber?: string;
  chargeBoxSerialNumber?: string;
  firmwareVersion?: string;
}

export interface BootNotificationResponse {
  status: 'Accepted' | 'Pending' | 'Rejected';
  interval: number;
  currentTime: string;
}

export interface HeartbeatResponse {
  currentTime: string;
}

export interface StatusNotificationRequest {
  connectorId: number;
  status: string;
  errorCode: string;
  info?: string;
  timestamp?: string;
}

export interface SampledValue {
  value: string;
  context?: string;
  format?: string;
  measurand?: string;
  phase?: string;
  location?: string;
  unit?: string;
}

export interface MeterValueBucket {
  timestamp: string;
  sampledValue: SampledValue[];
}

export interface MeterValuesRequest {
  connectorId: number;
  transactionId?: number;
  meterValue: MeterValueBucket[];
}

export interface IdTagInfo {
  status: string;
  parentIdTag?: string;
  expiryDate?: string;
}

export interface AuthorizeRequest {
  idTag: string;
}

export interface AuthorizeResponse {
  idTagInfo: IdTagInfo;
}

export interface StartTransactionRequest {
  connectorId: number;
  idTag: string;
  meterStart: number;
  timestamp: string;
  reservationId?: number;
}

export interface StartTransactionResponse {
  transactionId: number;
  idTagInfo: IdTagInfo;
}

export interface StopTransactionRequest {
  transactionId: number;
  idTag?: string;
  meterStop: number;
  timestamp: string;
  reason?: string;
}

export interface StopTransactionResponse {
  idTagInfo?: IdTagInfo;
}

export interface DataTransferRequest {
  vendorId: string;
  messageId?: string;
  data?: string | Record<string, unknown>;
}

export interface DataTransferResponse {
  status: string;
  data?: string;
}
