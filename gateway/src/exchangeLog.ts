/**
 * Formats one relayed OCPP exchange as a single, greppable stdout line:
 * timestamp, direction, outcome, identity, method, and the full payload
 * (params + response, or the error). This is the only visibility into what
 * the relay is actually doing - read via Gladys's native container log
 * viewer (supervision screen -> container selector -> "gateway"), not a
 * separate debug UI (see stateApi.ts's header comment for why).
 */

export type ExchangeDirection = 'EV Charger -> Primary' | 'Primary -> EV Charger';

export interface ExchangeOutcome {
  ok: boolean;
  response?: unknown;
  error?: string;
}

export function formatExchangeLog(
  direction: ExchangeDirection,
  identity: string,
  method: string,
  params: unknown,
  outcome: ExchangeOutcome,
): string {
  const timestamp = new Date().toISOString();
  const status = outcome.ok ? 'OK' : 'FAILED';
  const tail = outcome.ok
    ? `response=${JSON.stringify(outcome.response)}`
    : `error=${outcome.error}`;
  return `[${timestamp}] [${direction}] [${status}] ${identity} ${method} params=${JSON.stringify(params)} ${tail}`;
}
