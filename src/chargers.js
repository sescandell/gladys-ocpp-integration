// -----------------------------------------------------------------------------
// The set of configured charge points: identity -> origin cloud URL.
//
// Deliberately NOT part of the manifest's `config_schema` (no fixed number of
// "slots"): it grows one charge point at a time via the `add_charger`
// manifest action (see index.js), and is persisted as free internal storage
// under the reserved config key `chargers_json` - a key outside the schema,
// which Gladys never displays in the generated config form (see the SDK's
// `setConfig` contract: keys outside config_schema are the integration's own
// storage). `getConfig()`/`onConfigUpdated` still deliver it like any other
// key, it just isn't rendered as a form field.
// -----------------------------------------------------------------------------

const CHARGERS_CONFIG_KEY = 'chargers_json';

/**
 * @param {Record<string, unknown>} rawConfig the full config object from the SDK
 * @returns {Record<string, string>} identity -> origin cloud URL
 */
export function parseChargersStore(rawConfig = {}) {
  const raw = rawConfig[CHARGERS_CONFIG_KEY];
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const chargers = {};
    for (const [identity, url] of Object.entries(parsed)) {
      if (
        typeof identity === 'string' &&
        identity.trim() !== '' &&
        typeof url === 'string' &&
        url.trim() !== ''
      ) {
        chargers[identity.trim()] = url.trim();
      }
    }
    return chargers;
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string>} chargers identity -> origin cloud URL
 * @returns {{chargers_json: string}} ready to pass to `gladys.setConfig()`
 */
export function serializeChargersStore(chargers) {
  return { [CHARGERS_CONFIG_KEY]: JSON.stringify(chargers) };
}

/**
 * @param {Record<string, string>} chargers current set
 * @param {string} identity
 * @param {string} originCloudUrl
 * @returns {Record<string, string>} new set with the charger added/updated
 */
export function upsertCharger(chargers, identity, originCloudUrl) {
  return { ...chargers, [identity]: originCloudUrl };
}

/**
 * @param {Record<string, string>} chargers current set
 * @param {string} identity
 * @returns {Record<string, string>} new set without that charger
 */
export function removeCharger(chargers, identity) {
  const { [identity]: _removed, ...rest } = chargers;
  return rest;
}
