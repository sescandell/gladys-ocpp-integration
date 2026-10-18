// -----------------------------------------------------------------------------
// Scripted situations, to see the dashboard widget in each of its states
// without clicking through them by hand. A scenario is an async function
// given the charge point, its parameters and an abortable `sleep(seconds)`.
//
// `durationSec` is REAL time: with the charge point's `speed` multiplier
// (energy accumulating faster than the clock), a one-minute session already
// delivers several kWh.
// -----------------------------------------------------------------------------

/**
 * @typedef {object} ScenarioParams
 * @property {number} connector
 * @property {number} durationSec real duration of the charging part
 * @property {number} [powerW]
 */

export const SCENARIOS = {
  'session-complete': {
    label: 'Session complète',
    description: 'Branche le véhicule, charge pendant la durée choisie, arrête et débranche.',
    async run(cp, { connector, durationSec, powerW }, { sleep }) {
      await cp.plugIn(connector);
      await sleep(3);
      await cp.startCharge(connector, { powerW });
      await sleep(durationSec);
      await cp.stopCharge(connector);
      await sleep(3);
      await cp.unplug(connector);
    },
  },

  'session-vehicle-full': {
    label: 'Charge interrompue par le véhicule',
    description:
      'Charge, puis le véhicule suspend (batterie pleine), reprend brièvement, puis fin de session.',
    async run(cp, { connector, durationSec, powerW }, { sleep }) {
      await cp.startCharge(connector, { powerW });
      await sleep(durationSec / 2);
      await cp.pause(connector, 'EV');
      await sleep(Math.max(5, durationSec / 4));
      await cp.resume(connector);
      await sleep(durationSec / 4);
      await cp.stopCharge(connector);
      await sleep(3);
      await cp.unplug(connector);
    },
  },

  'session-station-pause': {
    label: 'Charge mise en pause par la borne',
    description: 'La borne suspend la charge (délestage), puis la reprend.',
    async run(cp, { connector, durationSec, powerW }, { sleep }) {
      await cp.startCharge(connector, { powerW });
      await sleep(durationSec / 3);
      await cp.pause(connector, 'EVSE');
      await sleep(Math.max(5, durationSec / 3));
      await cp.resume(connector);
      await sleep(durationSec / 3);
      await cp.stopCharge(connector);
      await sleep(3);
      await cp.unplug(connector);
    },
  },

  'several-sessions': {
    label: '3 sessions à la suite',
    description:
      'Trois sessions courtes de puissances différentes : remplit « Sessions récentes ».',
    async run(cp, { connector, durationSec, powerW }, { sleep }) {
      const max = powerW ?? cp.config.maxPowerW;
      const share = Math.max(10, durationSec / 3);
      for (const factor of [1, 0.5, 0.75]) {
        await cp.startCharge(connector, { powerW: max * factor });
        await sleep(share);
        await cp.stopCharge(connector);
        await sleep(2);
        await cp.unplug(connector);
        await sleep(3);
      }
    },
  },

  'plugged-idle': {
    label: 'Véhicule branché, sans charge',
    description: 'Le véhicule est branché (Preparing) mais la charge ne démarre pas.',
    async run(cp, { connector }) {
      await cp.plugIn(connector);
    },
  },

  fault: {
    label: 'Défaut puis rétablissement',
    description:
      'La borne passe en défaut (GroundFailure) pendant 20 s, puis redevient disponible.',
    async run(cp, { connector }, { sleep }) {
      await cp.fault(connector, 'GroundFailure');
      await sleep(20);
      await cp.clearFault(connector);
    },
  },

  unavailable: {
    label: 'Indisponible',
    description: 'Le connecteur passe en Unavailable pendant 20 s, puis redevient disponible.',
    async run(cp, { connector }, { sleep }) {
      await cp.setStatus(connector, 'Unavailable');
      await sleep(20);
      await cp.setStatus(connector, 'Available');
    },
  },

  'connection-drop': {
    label: 'Coupure de connexion',
    description: 'La borne se déconnecte 15 s (comme une coupure réseau), puis se reconnecte.',
    async run(cp, _params, { sleep }) {
      await cp.disconnect();
      await sleep(15);
      await cp.connect();
    },
  },
};

/** Serializable description for the UI. */
export function listScenarios() {
  return Object.entries(SCENARIOS).map(([key, { label, description }]) => ({
    key,
    label,
    description,
  }));
}

/**
 * Runs one scenario at a time; `stop()` aborts the running one at its next
 * wait. Emits nothing itself - the server reads `current`.
 */
export class ScenarioRunner {
  constructor(chargePoint, { onChange = () => {}, onError = () => {} } = {}) {
    this.chargePoint = chargePoint;
    this.onChange = onChange;
    this.onError = onError;
    /** @type {{key: string, startedAt: string, controller: AbortController} | null} */
    this.current = null;
  }

  get state() {
    return this.current ? { key: this.current.key, startedAt: this.current.startedAt } : null;
  }

  async start(key, params) {
    const scenario = SCENARIOS[key];
    if (!scenario) throw new Error(`Unknown scenario ${key}`);
    if (this.current) throw new Error('A scenario is already running');

    const controller = new AbortController();
    this.current = { key, startedAt: new Date().toISOString(), controller };
    this.onChange();

    const sleep = (seconds) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });

    // Not awaited: the HTTP call returns right away, the UI follows the state.
    scenario
      .run(this.chargePoint, params, { sleep })
      .catch((err) => {
        if (err.message !== 'aborted') this.onError(err);
      })
      .finally(() => {
        this.current = null;
        this.onChange();
      });
  }

  stop() {
    this.current?.controller.abort();
  }
}
