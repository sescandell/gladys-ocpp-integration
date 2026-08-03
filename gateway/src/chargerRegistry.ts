/**
 * Mutable, in-memory registry of configured charge points (identity -> origin
 * cloud URL). Updated live by the main integration container (see
 * `stateApi.ts`'s `POST /api/chargers`) as the user runs the `add_charger`
 * manifest action - no restart of this sub-container needed to pick up a
 * newly configured (or removed) charge point, which matters because a
 * restart would drop every OTHER charge point's live OCPP session, not just
 * the one being (re)configured.
 *
 * An identity absent from this registry is not an error: the charge point
 * connects fine and is fully supervised (see gateway.ts's "local mode"),
 * just not yet relayed to a real cloud - so this registry only ever needs
 * to answer ONE question, "does this identity have a configured origin
 * cloud URL yet". Which identities actually exist is `StateStore`'s job
 * (state.ts), not this registry's - it reflects real connections, not
 * config.
 *
 * Resets on restart, same as the rest of this process's state (documented
 * limitation): the main container re-pushes the full known map on every
 * `connected`/`config-updated` cycle, so this self-heals quickly.
 */

export class ChargerRegistry {
  private map: Map<string, string> = new Map();

  /** Origin cloud URL for a configured identity, or undefined if unknown. */
  resolve(identity: string): string | undefined {
    return this.map.get(identity);
  }

  /**
   * Full replace of the configured identity -> origin cloud URL map (the
   * main container always pushes its complete, current set - see
   * `src/gatewayClient.js`'s `syncChargerMap`).
   */
  replaceMap(entries: Record<string, string>): void {
    this.map = new Map(Object.entries(entries));
  }

  toJSON(): { configuredCount: number } {
    return { configuredCount: this.map.size };
  }
}
