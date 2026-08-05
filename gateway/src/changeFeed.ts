/**
 * Change notifications towards the main integration container.
 *
 * The gateway observes OCPP traffic as it happens, but only ever answered
 * `GET /api/state` - so the main container could not know a charge point had
 * moved without asking. This feed is the missing direction: `notify()` on
 * every observed change, subscribers pushed to over SSE (see stateApi.ts's
 * `GET /api/events`).
 *
 * Bursts are coalesced per identity: a charge point sending StatusNotification
 * and MeterValues back to back yields ONE event carrying the resulting state,
 * not one per message. The payload is the charger's full `toJSON()`, so a
 * subscriber never has to call back for the detail.
 */

import type { StateStore, ChargerStateJSON } from './state.ts';

export interface ChargerChange {
  identity: string;
  charger: ChargerStateJSON;
}

export type ChangeListener = (change: ChargerChange) => void;

export interface ChangeFeed {
  /** Signals that `identity`'s observed state may have changed. */
  notify(identity: string): void;
  subscribe(listener: ChangeListener): () => void;
  /** Drops every listener and pending timer (test/shutdown hygiene). */
  close(): void;
  readonly listenerCount: number;
}

const DEFAULT_COALESCE_MS = 250;

export function createChangeFeed(
  store: StateStore,
  options: { coalesceMs?: number } = {},
): ChangeFeed {
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const listeners = new Set<ChangeListener>();
  const pending = new Map<string, NodeJS.Timeout>();

  function emit(identity: string): void {
    if (listeners.size === 0) return;
    const change: ChargerChange = { identity, charger: store.get(identity).toJSON() };
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        // one broken subscriber must not stop the others, nor bubble up into
        // the OCPP message handler that triggered this
      }
    }
  }

  return {
    notify(identity: string): void {
      if (coalesceMs <= 0) {
        emit(identity);
        return;
      }
      // Already scheduled: the pending emit will read the newest state anyway.
      if (pending.has(identity)) return;
      const timer = setTimeout(() => {
        pending.delete(identity);
        emit(identity);
      }, coalesceMs);
      timer.unref?.();
      pending.set(identity, timer);
    },

    subscribe(listener: ChangeListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    close(): void {
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();
      listeners.clear();
    },

    get listenerCount(): number {
      return listeners.size;
    },
  };
}
