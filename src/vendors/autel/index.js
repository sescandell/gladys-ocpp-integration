// -----------------------------------------------------------------------------
// Autel charge points: the permanent cable lock (a vendor extension, see
// gateway/src/vendors/autel/ for the wire format and how its state is learned).
//
// What it adds, on charge points the gateway confirmed to have it:
//   - a writable `Cable lock` switch per connector (1 = locked, 0 = unlocked),
//     whose value is published once known - the charge point never reports it,
//     so there is none until a lock command has been seen;
//   - the command behind that switch;
//   - the widget button(s): the opposite of the known state, both while it is
//     unknown.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { featureExternalId } from '../../devices/ids.js';
import { sendCommand } from '../../gatewayClient.js';

const ID = 'autel';
const LOCK_FEATURE = 'permanent-lock';
const LOCK_COMMAND = 'permanent-lock';

/** The lock of one connector as the gateway recorded it: true, false, or undefined (unknown). */
const lockOf = (chargeState, connectorId) =>
  chargeState?.extensions?.[ID]?.connectors?.[connectorId]?.permanentLock;

export const autel = {
  id: ID,

  matches: (chargeState) => chargeState?.extensions?.[ID]?.supported === true,

  connectorFeatures(ids, connectorId) {
    return [
      {
        name: `Connector ${connectorId} - Cable lock`,
        external_id: featureExternalId(ids, LOCK_FEATURE, connectorId),
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        // The state flows back: learned from the exchanges, whoever started
        // the command (see the gateway module).
        has_feedback: true,
        keep_history: true,
      },
    ];
  },

  connectorStates(ids, connectorId, chargeState) {
    const lock = lockOf(chargeState, connectorId);
    if (typeof lock !== 'boolean') return []; // unknown: never a guessed value
    return [
      {
        device_feature_external_id: featureExternalId(ids, LOCK_FEATURE, connectorId),
        state: lock ? 1 : 0,
      },
    ];
  },

  commands: {
    // Nothing is published from here: the state comes back through the
    // gateway's change stream once the charge point accepted the command (see
    // index.js), so a refused command never shows as done.
    [LOCK_FEATURE]: async ({ identity, connectorId, value, gatewayBaseUrl }) => {
      const lock = Number(value);
      if (lock !== 0 && lock !== 1) {
        throw new Error(`Invalid cable lock value: ${value}`);
      }
      await sendCommand(
        { identity, connectorId, command: LOCK_COMMAND, value: lock === 1 },
        gatewayBaseUrl,
      );
    },
  },

  widgetComponents({ ids, connectorId, chargeState, t }) {
    const feature = featureExternalId(ids, LOCK_FEATURE, connectorId);
    const button = (label, icon, value) => ({
      type: 'button',
      label,
      icon,
      style: 'secondary',
      device_feature: feature,
      value,
    });
    const lock = button(t({ en: 'Lock cable', fr: 'Verrouiller le câble' }), 'lock', 1);
    const unlock = button(t({ en: 'Unlock cable', fr: 'Déverrouiller le câble' }), 'unlock', 0);
    const locked = lockOf(chargeState, connectorId);
    if (locked === true) return [unlock];
    if (locked === false) return [lock];
    return [lock, unlock];
  },
};
