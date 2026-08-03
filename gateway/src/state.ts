/**
 * Internal state model: one ChargerState per connected charge point, with a
 * sub-state per connector. Connector ids are never assumed in advance - a new
 * key is created in the map the first time a given connector is observed
 * (StatusNotification), which is what makes multi-connector discovery work
 * without any hardcoded connector count.
 */

export interface ConnectorState {
  status: string;
  errorCode: string | null;
  transactionId: number | null;
  idTag: string | null;
  energyActiveImportRegisterWh: number | null;
  powerActiveImportW: number | null;
  powerOfferedW: number | null;
  currentImportA: number | null;
  currentOfferedA: number | null;
  voltageV: number | null;
  lastMeterValueAt: string | null;
  lastStatusAt: string | null;
}

function emptyConnector(): ConnectorState {
  return {
    status: 'Unknown',
    errorCode: null,
    transactionId: null,
    idTag: null,
    energyActiveImportRegisterWh: null,
    powerActiveImportW: null,
    powerOfferedW: null,
    currentImportA: null,
    currentOfferedA: null,
    voltageV: null,
    lastMeterValueAt: null,
    lastStatusAt: null,
  };
}

/** A charging session, active (ChargerState.transactions) or closed (ChargerState.history). */
export interface TransactionRecord {
  transactionId: number;
  connectorId: number;
  idTag: string;
  meterStart: number;
  meterStop: number | null;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
}

/** Number of closed transactions kept for recent history. */
const HISTORY_LIMIT = 20;

export interface ChargerStateJSON {
  identity: string;
  vendor: string | null;
  model: string | null;
  firmwareVersion: string | null;
  lastSeenAt: string | null;
  connectors: Record<number, ConnectorState>;
  history: TransactionRecord[];
}

export class ChargerState {
  readonly identity: string;
  readonly connectors: Map<number, ConnectorState> = new Map();
  /** Transactions in progress, indexed by transactionId (one per connector in practice). */
  readonly transactions: Map<number, TransactionRecord> = new Map();
  /** Closed transactions, most recent first, capped at HISTORY_LIMIT. */
  readonly history: TransactionRecord[] = [];
  vendor: string | null = null;
  model: string | null = null;
  firmwareVersion: string | null = null;
  lastSeenAt: string | null = null;

  constructor(identity: string) {
    this.identity = identity;
  }

  connector(connectorId: number): ConnectorState {
    let state = this.connectors.get(connectorId);
    if (!state) {
      state = emptyConnector();
      this.connectors.set(connectorId, state);
    }
    return state;
  }

  patchConnector(connectorId: number, patch: Partial<ConnectorState>): ConnectorState {
    const current = this.connector(connectorId);
    Object.assign(current, patch);
    this.lastSeenAt = new Date().toISOString();
    return current;
  }

  /** Opens a transaction: records the active entry and updates the connector. */
  startTransaction(
    connectorId: number,
    transactionId: number,
    idTag: string,
    meterStart: number,
    startedAt: string,
  ): TransactionRecord {
    const record: TransactionRecord = {
      transactionId,
      connectorId,
      idTag,
      meterStart,
      meterStop: null,
      startedAt,
      stoppedAt: null,
      stopReason: null,
    };
    this.transactions.set(transactionId, record);
    this.patchConnector(connectorId, {
      transactionId,
      idTag,
      energyActiveImportRegisterWh: meterStart,
    });
    return record;
  }

  /**
   * Closes a known transaction and archives it into history. Returns null if
   * the transactionId is unknown (e.g. the process restarted mid-session) -
   * the caller is responsible for still answering Accepted (the charge point
   * must not stay stuck).
   */
  stopTransaction(
    transactionId: number,
    meterStop: number,
    stoppedAt: string,
    reason: string | null,
  ): TransactionRecord | null {
    const record = this.transactions.get(transactionId);
    if (!record) return null;

    record.meterStop = meterStop;
    record.stoppedAt = stoppedAt;
    record.stopReason = reason;

    this.transactions.delete(transactionId);
    this.history.unshift(record);
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);

    this.patchConnector(record.connectorId, { transactionId: null, idTag: null });
    return record;
  }

  toJSON(): ChargerStateJSON {
    return {
      identity: this.identity,
      vendor: this.vendor,
      model: this.model,
      firmwareVersion: this.firmwareVersion,
      lastSeenAt: this.lastSeenAt,
      connectors: Object.fromEntries(this.connectors) as Record<number, ConnectorState>,
      history: this.history,
    };
  }
}

export class StateStore {
  readonly chargers: Map<string, ChargerState> = new Map();

  get(identity: string): ChargerState {
    let state = this.chargers.get(identity);
    if (!state) {
      state = new ChargerState(identity);
      this.chargers.set(identity, state);
    }
    return state;
  }

  toJSON(): Record<string, ChargerStateJSON> {
    return Object.fromEntries(
      [...this.chargers.entries()].map(([id, state]) => [id, state.toJSON()]),
    );
  }

  /**
   * Discards ALL observed state for `identity` (connectors, in-progress
   * transactions, history) and starts it fresh. Used when a charge point
   * switches from local mode (no real origin cloud, fake locally-invented
   * transaction ids - see localMode.ts) into relay mode: a transaction
   * started locally is meaningless once a REAL origin cloud is about to
   * assign its own. Best-effort display cleanup, not a full protocol fix -
   * see gateway.ts's header comment on the known limitation if the charge
   * point itself keeps referencing the old (fake) transaction id after
   * reconnecting.
   */
  reset(identity: string): void {
    this.chargers.set(identity, new ChargerState(identity));
  }
}
