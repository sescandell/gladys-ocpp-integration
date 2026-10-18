/**
 * Vendor module for Autel charge points: the permanent connector lock (see
 * protocol.ts for the wire format).
 *
 * What it adds to the generic gateway:
 * - it decides whether the charge point really has the lock, instead of
 *   trusting the vendor name alone: it asks for `SupportedFunctionLists` after
 *   boot (`probe`), and also reads the same answer when the origin cloud asks
 *   (`observeOutgoing`);
 * - the lock state. The charge point never reports it, so it is the outcome of
 *   the last ACCEPTED lock command seen, whoever sent it (this gateway, or the
 *   origin cloud for the vendor's app, relayed through here). Unknown until
 *   one is seen;
 * - the `permanent-lock` command.
 *
 * State lives in `state.extension('autel')`: `supported`, and per connector
 * `{ permanentLock: boolean }`.
 */

import { CommandError } from '../../commandError.ts';
import type { ChargerState } from '../../state.ts';
import type { VendorCommand, VendorModule } from '../types.ts';
import {
  isAutel,
  parsePermanentLock,
  parsePermanentLockSupport,
  permanentLockRequest,
  SUPPORTED_FUNCTIONS_KEY,
} from './protocol.ts';

export const AUTEL_MODULE_ID = 'autel';

function recordLock(state: ChargerState, connectorId: number, lock: boolean): void {
  const data = state.extension(AUTEL_MODULE_ID);
  // A charge point that accepted the command obviously has the feature.
  data.supported = true;
  data.connectors[connectorId] = { ...data.connectors[connectorId], permanentLock: lock };
}

const setPermanentLock: VendorCommand = async (context, { connectorId, value }) => {
  if (typeof value !== 'boolean') {
    throw new CommandError(400, 'permanent-lock expects a boolean value');
  }
  if (!context.state.extension(AUTEL_MODULE_ID).supported) {
    throw new CommandError(422, `${context.identity} does not offer the permanent connector lock`);
  }

  const params = permanentLockRequest(connectorId, value);
  const response = await context.call('DataTransfer', params);
  if (!parsePermanentLock(params, response)) {
    throw new CommandError(502, `${context.identity} refused the lock command`);
  }
  recordLock(context.state, connectorId, value);
};

export const autel: VendorModule = {
  id: AUTEL_MODULE_ID,

  matches: (state) => isAutel(state.vendor),

  async probe(context) {
    const response = await context.call('GetConfiguration', { key: [SUPPORTED_FUNCTIONS_KEY] });
    const supported = parsePermanentLockSupport(response);
    if (supported !== null) {
      context.state.extension(AUTEL_MODULE_ID).supported = supported;
    }
  },

  observeOutgoing(state, method, params, response) {
    if (method === 'GetConfiguration') {
      const supported = parsePermanentLockSupport(response);
      if (supported !== null) state.extension(AUTEL_MODULE_ID).supported = supported;
      return;
    }
    if (method === 'DataTransfer') {
      const lock = parsePermanentLock(params, response);
      if (lock) recordLock(state, lock.connectorId, lock.lock);
    }
  },

  commands: { 'permanent-lock': setPermanentLock },
};
