// -----------------------------------------------------------------------------
// Device registry.
//
// Each blueprint exposes:
//   - key                          : short identifier (used in logs)
//   - ownsDevice(gladys, externalId): prefix-based dispatch (a blueprint can
//     offer several devices, discovered at runtime - see charger.js)
//   - buildDevices(gladys, config) : async, returns the CURRENT array of
//     discovery payloads to offer (can grow/shrink over time)
//   - onPoll(gladys, config, device) (optional): periodic read for one device
// -----------------------------------------------------------------------------

import { charger } from './charger.js';

export const DEVICE_BLUEPRINTS = [charger];

/**
 * Build the discovery payload for Gladys (every device every blueprint
 * currently has to offer). Async because blueprints may need to query the
 * gateway sub-container to know what they can currently offer.
 */
export async function buildDiscoveredDevices(gladys, config) {
  const lists = await Promise.all(DEVICE_BLUEPRINTS.map((bp) => bp.buildDevices(gladys, config)));
  return lists.flat();
}

/**
 * Find the blueprint that owns a given device, from its external_id (used to
 * route onPoll to the right blueprint).
 */
export function findBlueprintByDevice(gladys, device) {
  return DEVICE_BLUEPRINTS.find((bp) => bp.ownsDevice(gladys, device.external_id));
}
