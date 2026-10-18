// -----------------------------------------------------------------------------
// A simulated OCPP 1.6 charge point: one WebSocket client towards the gateway
// (or any CSMS), N connectors, and the handful of actions a person would do
// on a real one (plug the car, start/pause/stop a charge, trip a fault...).
//
// It speaks the same library as the gateway (ocpp-rpc), so what the gateway
// observes here is exactly what a real charge point would send:
// BootNotification, StatusNotification, Authorize, StartTransaction,
// MeterValues (energy register, power, current, voltage, offered), StopTransaction.
//
// Energy accumulates in real time at `powerW`, multiplied by `speed`: with a
// speed of 60, one real minute adds the energy of one simulated hour - enough
// to fill the dashboard widget in a few minutes.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { RPCClient } from 'ocpp-rpc';

export const STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEVSE',
  'SuspendedEV',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
];

export const ERROR_CODES = [
  'NoError',
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'UnderVoltage',
  'OtherError',
];

export const DEFAULT_CONFIG = {
  url: 'ws://localhost:9321/',
  identity: 'SIMULATOR-1',
  vendor: 'Simulator',
  model: 'SimCharge 7',
  serialNumber: 'SIM-0001',
  firmwareVersion: '1.0.0',
  connectors: 1,
  voltageV: 230,
  maxPowerW: 7400,
  meterIntervalSec: 10,
  heartbeatIntervalSec: 60,
  speed: 60,
  initialMeterWh: 120000,
};

const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export class SimulatedChargePoint extends EventEmitter {
  /**
   * @param {Partial<typeof DEFAULT_CONFIG>} config
   * @param {{random?: () => number, now?: () => number}} [deps] overridden by the tests
   */
  constructor(config = {}, { random = Math.random, now = Date.now } = {}) {
    super();
    this.random = random;
    this.now = now;
    this.config = { ...DEFAULT_CONFIG };
    this.connection = 'disconnected'; // disconnected | connecting | connected
    this.lastError = null;
    this.client = null;
    this.timers = [];
    this.connectors = new Map();
    this.configure(config);
  }

  /** Applies a (partial) configuration; the connector set is rebuilt when idle. */
  configure(patch = {}) {
    this.config = { ...this.config, ...patch };
    if (this.connection === 'disconnected') this.#resetConnectors();
    this.emit('change');
  }

  #resetConnectors() {
    const count = Math.max(1, Math.min(10, Number(this.config.connectors) || 1));
    this.connectors = new Map();
    for (let id = 1; id <= count; id += 1) {
      this.connectors.set(id, {
        id,
        status: 'Available',
        errorCode: 'NoError',
        transactionId: null,
        idTag: null,
        // Autel permanent cable lock: only moved by the CSMS' DataTransfer.
        permanentLock: false,
        meterWh: Number(this.config.initialMeterWh) || 0,
        powerW: 0,
        targetPowerW: Number(this.config.maxPowerW),
        lastTickAt: this.now(),
      });
    }
  }

  snapshot() {
    return {
      config: this.config,
      connection: this.connection,
      lastError: this.lastError,
      connectors: [...this.connectors.values()].map((c) => ({
        ...c,
        meterWh: round(c.meterWh),
        powerW: round(c.powerW),
        currentA: this.#currentA(c),
      })),
    };
  }

  #connector(id) {
    const connector = this.connectors.get(Number(id));
    if (!connector) throw new Error(`Unknown connector ${id}`);
    return connector;
  }

  #currentA(connector) {
    return round(connector.powerW / this.config.voltageV, 1);
  }

  #log(entry) {
    this.emit('log', { at: new Date(this.now()).toISOString(), ...entry });
  }

  #changed() {
    this.emit('change');
  }

  // --- Connection -----------------------------------------------------------

  async connect() {
    if (this.client) throw new Error('Already connected or connecting');
    const endpoint = String(this.config.url).replace(/\/+$/, '');
    if (!/^wss?:\/\//.test(endpoint)) throw new Error('The URL must start with ws:// or wss://');

    this.lastError = null;
    this.connection = 'connecting';
    this.#changed();

    const client = new RPCClient({
      endpoint,
      identity: this.config.identity,
      protocols: ['ocpp1.6'],
      strictMode: false,
    });
    this.client = client;

    client.on('close', () => {
      if (this.client === client) this.client = null;
      this.#stopTimers();
      this.connection = 'disconnected';
      this.#log({ kind: 'info', text: 'Connection closed' });
      this.#changed();
    });
    client.on('disconnect', ({ code, reason }) => {
      this.#stopTimers();
      this.#log({ kind: 'info', text: `Connection lost (${code} ${reason || ''}), retrying` });
      this.connection = 'connecting';
      this.#changed();
    });
    client.on('open', () => {
      // Also fires on an automatic reconnect: introduce ourselves again, like a real firmware.
      this.#onOpen().catch((err) => this.#fail(err));
    });
    this.#registerIncomingCalls(client);

    try {
      await client.connect();
    } catch (err) {
      this.client = null;
      this.#stopTimers();
      this.connection = 'disconnected';
      this.lastError = err.message;
      this.#log({ kind: 'error', text: `Connection failed: ${err.message}` });
      this.#changed();
      throw err;
    }
  }

  async disconnect() {
    const client = this.client;
    if (!client) return;
    await client.close({ awaitPending: false }).catch(() => {});
  }

  #fail(err) {
    this.lastError = err.message;
    this.#log({ kind: 'error', text: err.message });
    this.#changed();
  }

  async #onOpen() {
    this.connection = 'connected';
    this.#changed();
    this.#log({ kind: 'info', text: `Connected as ${this.config.identity}` });

    const boot = await this.#call('BootNotification', {
      chargePointVendor: this.config.vendor,
      chargePointModel: this.config.model,
      chargePointSerialNumber: this.config.serialNumber,
      firmwareVersion: this.config.firmwareVersion,
    });
    const heartbeatSec = Number(boot?.interval) > 0 ? Number(boot.interval) : 60;

    await this.#call('StatusNotification', {
      connectorId: 0,
      status: 'Available',
      errorCode: 'NoError',
      timestamp: new Date(this.now()).toISOString(),
    });
    for (const connector of this.connectors.values()) {
      await this.#sendStatus(connector);
    }

    this.#stopTimers();
    this.timers.push(
      setInterval(
        () => this.#call('Heartbeat', {}).catch(() => {}),
        Math.min(heartbeatSec, Number(this.config.heartbeatIntervalSec)) * 1000,
      ),
      setInterval(
        () => this.tick().catch(() => {}),
        Math.max(1, Number(this.config.meterIntervalSec)) * 1000,
      ),
    );
    for (const timer of this.timers) timer.unref?.();
  }

  #stopTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  #isAutel() {
    return String(this.config.vendor).trim().toLowerCase() === 'autel';
  }

  /** The few CALLs a CSMS may send to a charge point. */
  #registerIncomingCalls(client) {
    const answer = (method, response) =>
      client.handle(method, ({ params }) => {
        const result = typeof response === 'function' ? response(params) : response;
        this.#log({ kind: 'in', method, params, response: result });
        return result;
      });
    answer('Reset', { status: 'Accepted' });
    answer('ChangeConfiguration', { status: 'NotSupported' });
    answer('GetConfiguration', (params) => {
      const key = 'SupportedFunctionLists';
      const wanted = params?.key;
      // Only an Autel announces its optional functions, like the real one.
      if (this.#isAutel() && (!wanted || wanted.includes(key))) {
        return {
          configurationKey: [
            { key, readonly: true, value: 'WIFI,Ethernet,MaxCurrent,PerManentLock,RS485,CT' },
          ],
        };
      }
      return { configurationKey: [], unknownKey: wanted ?? [] };
    });
    answer('UnlockConnector', { status: 'NotSupported' });
    answer('ChangeAvailability', { status: 'Accepted' });
    // Vendor extension: only answered when the simulated vendor is Autel (set
    // it in the configuration), like the real charge point. The lock is a
    // plain flag - it never shows in any message the charge point sends.
    answer('DataTransfer', (params) => {
      if (!this.#isAutel() || params?.vendorId !== 'Autel') return { status: 'UnknownVendorId' };
      if (params.messageId !== 'PermanentLockConnector') return { status: 'UnknownMessageId' };
      const connector = this.connectors.get(Number(params.data?.connectorId));
      if (!connector || typeof params.data?.lock !== 'boolean') return { status: 'Rejected' };
      connector.permanentLock = params.data.lock;
      this.#changed();
      return { status: 'Accepted', data: JSON.stringify({ status: 0 }) };
    });
    answer('TriggerMessage', (params) => {
      if (params?.requestedMessage === 'StatusNotification') {
        for (const connector of this.connectors.values()) {
          this.#sendStatus(connector).catch(() => {});
        }
      }
      if (params?.requestedMessage === 'MeterValues') this.tick().catch(() => {});
      return { status: 'Accepted' };
    });
    answer('RemoteStartTransaction', (params) => {
      const id = Number(params?.connectorId ?? 1);
      this.startCharge(id, { idTag: params?.idTag }).catch((err) => this.#fail(err));
      return { status: 'Accepted' };
    });
    answer('RemoteStopTransaction', (params) => {
      const connector = [...this.connectors.values()].find(
        (c) => c.transactionId === params?.transactionId,
      );
      if (!connector) return { status: 'Rejected' };
      this.stopCharge(connector.id, { reason: 'Remote' }).catch((err) => this.#fail(err));
      return { status: 'Accepted' };
    });
  }

  async #call(method, params) {
    if (!this.client || this.connection !== 'connected') {
      throw new Error('Not connected');
    }
    try {
      const response = await this.client.call(method, params);
      this.#log({ kind: 'out', method, params, response });
      return response;
    } catch (err) {
      this.#log({ kind: 'error', method, params, text: err.message });
      throw err;
    }
  }

  // --- Reporting ------------------------------------------------------------

  async #sendStatus(connector) {
    await this.#call('StatusNotification', {
      connectorId: connector.id,
      status: connector.status,
      errorCode: connector.errorCode,
      timestamp: new Date(this.now()).toISOString(),
    });
  }

  /** Moves a connector to a status and tells the CSMS (when connected). */
  async setStatus(id, status, errorCode = 'NoError') {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
    if (!ERROR_CODES.includes(errorCode)) throw new Error(`Unknown error code ${errorCode}`);
    const connector = this.#connector(id);
    connector.status = status;
    connector.errorCode = errorCode;
    if (status !== 'Charging') connector.powerW = 0;
    this.#changed();
    if (this.connection === 'connected') await this.#sendStatus(connector);
  }

  /** Advances the energy register and sends the MeterValues of every connector. */
  async tick() {
    const nowMs = this.now();
    for (const connector of this.connectors.values()) {
      const elapsedSec = Math.max(0, (nowMs - connector.lastTickAt) / 1000);
      connector.lastTickAt = nowMs;
      if (connector.status === 'Charging') {
        const jitter = 1 + (this.random() - 0.5) * 0.02;
        connector.powerW = round(connector.targetPowerW * jitter);
        connector.meterWh += (connector.powerW * elapsedSec * Number(this.config.speed)) / 3600;
      } else {
        connector.powerW = 0;
      }
    }
    this.#changed();
    if (this.connection !== 'connected') return;

    const timestamp = new Date(nowMs).toISOString();
    for (const connector of this.connectors.values()) {
      const offeredA = round(connector.targetPowerW / this.config.voltageV, 1);
      const params = {
        connectorId: connector.id,
        meterValue: [
          {
            timestamp,
            sampledValue: [
              {
                measurand: 'Energy.Active.Import.Register',
                unit: 'Wh',
                value: String(round(connector.meterWh)),
              },
              { measurand: 'Power.Active.Import', unit: 'W', value: String(connector.powerW) },
              { measurand: 'Current.Import', unit: 'A', value: String(this.#currentA(connector)) },
              { measurand: 'Voltage', unit: 'V', value: String(this.config.voltageV) },
              { measurand: 'Power.Offered', unit: 'W', value: String(connector.targetPowerW) },
              { measurand: 'Current.Offered', unit: 'A', value: String(offeredA) },
            ],
          },
        ],
      };
      if (connector.transactionId !== null) params.transactionId = connector.transactionId;
      await this.#call('MeterValues', params).catch(() => {});
    }
  }

  // --- What a person does ---------------------------------------------------

  /** The car is plugged in. */
  async plugIn(id) {
    await this.setStatus(id, 'Preparing');
  }

  /** The car is unplugged (a running charge is stopped first). */
  async unplug(id) {
    const connector = this.#connector(id);
    if (connector.transactionId !== null) await this.stopCharge(id, { reason: 'EVDisconnected' });
    await this.setStatus(id, 'Available');
  }

  async startCharge(id, { idTag = 'SIMULATOR', powerW } = {}) {
    const connector = this.#connector(id);
    if (connector.transactionId !== null) throw new Error(`Connector ${id} is already charging`);
    if (connector.status === 'Available') await this.plugIn(id);
    if (powerW !== undefined) connector.targetPowerW = this.#clampPower(powerW);

    const auth = await this.#call('Authorize', { idTag });
    if (auth?.idTagInfo?.status && auth.idTagInfo.status !== 'Accepted') {
      throw new Error(`Authorize refused: ${auth.idTagInfo.status}`);
    }
    const started = await this.#call('StartTransaction', {
      connectorId: connector.id,
      idTag,
      meterStart: round(connector.meterWh),
      timestamp: new Date(this.now()).toISOString(),
    });
    if (started?.idTagInfo?.status && started.idTagInfo.status !== 'Accepted') {
      throw new Error(`StartTransaction refused: ${started.idTagInfo.status}`);
    }
    connector.transactionId = started.transactionId;
    connector.idTag = idTag;
    connector.lastTickAt = this.now();
    await this.setStatus(id, 'Charging');
    await this.tick();
  }

  async stopCharge(id, { reason = 'Local' } = {}) {
    const connector = this.#connector(id);
    if (connector.transactionId === null) throw new Error(`No charge in progress on ${id}`);
    await this.tick();
    const params = {
      transactionId: connector.transactionId,
      idTag: connector.idTag ?? undefined,
      meterStop: round(connector.meterWh),
      timestamp: new Date(this.now()).toISOString(),
      reason,
    };
    connector.transactionId = null;
    connector.idTag = null;
    connector.powerW = 0;
    this.#changed();
    await this.#call('StopTransaction', params);
    await this.setStatus(id, 'Finishing');
  }

  /** @param {'EV'|'EVSE'} by who suspends the charge: the vehicle or the charge point */
  async pause(id, by = 'EV') {
    await this.setStatus(id, by === 'EVSE' ? 'SuspendedEVSE' : 'SuspendedEV');
  }

  async resume(id) {
    await this.setStatus(id, 'Charging');
  }

  async setPower(id, powerW) {
    const connector = this.#connector(id);
    connector.targetPowerW = this.#clampPower(powerW);
    this.#changed();
  }

  async fault(id, errorCode = 'GroundFailure') {
    await this.setStatus(id, 'Faulted', errorCode === 'NoError' ? 'OtherError' : errorCode);
  }

  async clearFault(id) {
    const connector = this.#connector(id);
    await this.setStatus(id, connector.transactionId !== null ? 'SuspendedEVSE' : 'Available');
  }

  #clampPower(powerW) {
    const value = Number(powerW);
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid power');
    return Math.min(round(value), Number(this.config.maxPowerW));
  }
}
