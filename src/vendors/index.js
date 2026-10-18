// -----------------------------------------------------------------------------
// Vendor modules of the main container (the gateway has its own, see
// gateway/src/vendors/).
//
// The generic charge point code (src/devices/charger.js, src/widgets/
// charger.js, index.js) knows nothing about any manufacturer. Whatever is
// specific to one - features only its charge points have, the states behind
// them, the commands, the widget buttons - lives in its own folder here and
// plugs in through the contract below. Nothing outside `vendors/` may name a
// manufacturer (test/vendors.test.js enforces it). To support another one: a
// folder next to `autel/`, one line in VENDORS.
//
// A module applies to a charge point when the gateway's vendor module says it
// really offers the vendor's extensions (`chargeState.extensions.<id>.supported`,
// decided by the gateway after probing the charge point), not on the vendor
// name alone.
//
// Contract - everything is optional but `id` and `matches`:
//
//   id                                     the key in `chargeState.extensions`
//   matches(chargeState)                   does it apply to this charge point?
//   connectorFeatures(ids, connectorId)    extra Gladys features of one connector
//   connectorStates(ids, connectorId, chargeState)
//                                          the states of those features
//   commands                               `{ [featureKey]: async ({ identity,
//                                          connectorId, value, gatewayBaseUrl }) }`
//                                          what to do when Gladys sets one of
//                                          the module's writable features
//   widgetComponents({ ids, connectorId, chargeState, t })
//                                          extra components of the dashboard
//                                          widget (buttons...), max
//                                          MAX_WIDGET_COMPONENTS
// -----------------------------------------------------------------------------

import { autel } from './autel/index.js';

export const VENDORS = [autel];

/** The most components one module may add to a widget (the core allows 4 buttons). */
export const MAX_WIDGET_COMPONENTS = 4;

/** The modules that apply to this charge point. */
export function activeVendors(chargeState) {
  return VENDORS.filter((vendor) => vendor.matches(chargeState));
}

/** The module whose writable feature `featureKey` is, if any. */
export function vendorForCommand(featureKey) {
  return VENDORS.find((vendor) => Object.hasOwn(vendor.commands ?? {}, featureKey));
}

/**
 * Which vendor modules apply, as a string: Discovery must be republished when
 * it changes, since the features of the device change with it.
 */
export function vendorsShape(chargeState) {
  return activeVendors(chargeState)
    .map((vendor) => vendor.id)
    .join(',');
}
