/**
 * Mutable, in-memory registry of configured charge points (identity -> origin
 * cloud URL) plus the set of identities seen connecting WITHOUT being
 * configured yet ("pending"). Updated live by the main integration container
 * (see `stateApi.ts`'s `POST /api/chargers`) as the user runs the
 * `add_charger` manifest action - no restart of this sub-container needed to
 * pick up a newly configured (or removed) charge point, which matters
 * because a restart would drop every OTHER charge point's live OCPP session,
 * not just the one being (re)configured.
 *
 * Resets on restart, same as the rest of this process's state (documented
 * limitation): the main container re-pushes the full known map on every
 * `connected`/`config-updated` cycle, so this self-heals quickly.
 */

export interface PendingChargerEntry {
  identity: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

// Bounds memory/log growth if a rogue LAN client spams fake identities at the
// (unauthenticated, by design - see docs) OCPP port. Oldest entries evicted
// first.
const PENDING_LIMIT = 50;

export class ChargerRegistry {
  private map: Map<string, string> = new Map();
  private pending: Map<string, PendingChargerEntry> = new Map();

  /** Origin cloud URL for a configured identity, or undefined if unknown. */
  resolve(identity: string): string | undefined {
    return this.map.get(identity);
  }

  /**
   * Records that `identity` just tried to connect without being configured.
   * Creates a new pending entry (or refreshes `lastSeenAt` for an existing
   * one); evicts the oldest pending entry first if over the cap.
   */
  recordPending(identity: string): void {
    const now = new Date().toISOString();
    const existing = this.pending.get(identity);
    if (existing) {
      existing.lastSeenAt = now;
      return;
    }
    if (this.pending.size >= PENDING_LIMIT) {
      const oldestKey = [...this.pending.values()].sort((a, b) =>
        a.firstSeenAt.localeCompare(b.firstSeenAt),
      )[0]?.identity;
      if (oldestKey !== undefined) this.pending.delete(oldestKey);
    }
    this.pending.set(identity, { identity, firstSeenAt: now, lastSeenAt: now });
  }

  /**
   * Full replace of the configured identity -> origin cloud URL map (the
   * main container always pushes its complete, current set - see
   * `src/gatewayClient.js`'s `syncChargerMap`). Any identity that is now
   * configured is cleared from the pending list, even if it hasn't
   * reconnected yet - it no longer needs the user's attention.
   */
  replaceMap(entries: Record<string, string>): void {
    this.map = new Map(Object.entries(entries));
    for (const identity of this.map.keys()) {
      this.pending.delete(identity);
    }
  }

  pendingList(): PendingChargerEntry[] {
    return [...this.pending.values()];
  }

  toJSON(): { configuredCount: number; pending: PendingChargerEntry[] } {
    return { configuredCount: this.map.size, pending: this.pendingList() };
  }
}
