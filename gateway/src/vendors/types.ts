/**
 * The contract of a VENDOR MODULE.
 *
 * The OCPP core of the gateway (gateway.ts, observe.ts, state.ts...) knows
 * nothing about any manufacturer. Whatever is specific to one - a vendor
 * extension carried by `DataTransfer`, a state the charge point never reports
 * on its own, a command only that brand understands - lives in its own folder
 * under `vendors/` and plugs in through this interface (list in `index.ts`).
 * Nothing outside `vendors/` may name a manufacturer (a test enforces it).
 *
 * The interface stays as small as the existing modules need: add a hook when
 * a real vendor needs it, not before.
 */

import type { ChargerState } from '../state.ts';

/** What a vendor module may do towards the charge point it is working on. */
export interface VendorContext {
  readonly identity: string;
  readonly state: ChargerState;
  /**
   * Sends an OCPP CALL to the charge point and resolves with its response.
   * Logged like every other exchange; a missing connection or an unanswered
   * call rejects with a `CommandError`.
   */
  call(method: string, params: unknown): Promise<unknown>;
}

/** One command a vendor module offers, addressed by name through the HTTP API. */
export type VendorCommand = (
  context: VendorContext,
  command: { connectorId: number; value: unknown },
) => Promise<void>;

export interface VendorModule {
  /** Stable key: the namespace of this vendor in `ChargerState.extension()`. */
  readonly id: string;

  /** Does this module apply to this charge point? (From what it announced.) */
  matches(state: ChargerState): boolean;

  /**
   * Called once per connection, shortly after the charge point booted, to
   * find out what it really supports. Records its findings in
   * `state.extension(id)`. A failure just leaves the charge point without the
   * vendor features.
   */
  probe?(context: VendorContext): Promise<void>;

  /**
   * Reads a CALL going TO the charge point (from the origin cloud, or from
   * this gateway) together with the charge point's response - the only trace
   * of some vendor state, which the charge point never reports itself.
   */
  observeOutgoing?(state: ChargerState, method: string, params: unknown, response: unknown): void;

  /** Commands by name (`POST /api/chargers/<id>/connectors/<n>/commands/<name>`). */
  readonly commands?: Readonly<Record<string, VendorCommand>>;
}
