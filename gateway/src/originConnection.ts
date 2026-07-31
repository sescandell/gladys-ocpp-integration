/**
 * Some OCPP cloud servers expect the charge point identity to be carried as a
 * query-string parameter rather than as a URL path segment (`ocpp-rpc`'s
 * `RPCClient` always builds its connection URL as
 * `endpoint + '/' + encodeURIComponent(identity)`, optionally followed by
 * `'?' + query` - see `node_modules/ocpp-rpc/lib/client.js`, `connect()`).
 *
 * Rather than special-casing any particular vendor, this module detects the
 * addressing mode STRUCTURALLY, from the shape of the configured origin cloud
 * URL: if it already contains a query string, we treat that as "this cloud
 * expects the identity in the query string" - the user is expected to paste
 * the exact URL shown by their charger's vendor app, which already ends with
 * the right query key left empty and ready to be filled in (e.g. "...?sn=").
 * Otherwise, standard OCPP path-segment addressing applies and `ocpp-rpc`
 * handles it natively.
 *
 * In query-string mode, `ocpp-rpc` must be prevented from ALSO appending the
 * real identity as a path segment: we pass it a neutral placeholder identity
 * ('.') instead, and put the real identity in `query`. The WHATWG URL parser
 * (used internally by `ws`) collapses a trailing "/." path segment, so the
 * wire URL ends up with an extra trailing slash right before the query string
 * compared to the URL as configured (e.g. ".../webSocket?sn=" on input
 * becomes ".../webSocket/?sn=<identity>" on the wire) - most HTTP/WS servers
 * are indifferent to that slash, but this is worth validating against real
 * hardware before relying on it.
 */

export interface PrimaryConnectionOptions {
  endpoint: string;
  identity: string;
  query?: Record<string, string>;
}

export type IdentityAddressingMode = 'path-segment' | 'query-string';

export function identityAddressingMode(originCloudUrl: string): IdentityAddressingMode {
  return new URL(originCloudUrl).search === '' ? 'path-segment' : 'query-string';
}

export function buildPrimaryConnectionOptions(
  originCloudUrl: string,
  identity: string,
): PrimaryConnectionOptions {
  if (identityAddressingMode(originCloudUrl) === 'path-segment') {
    return { endpoint: originCloudUrl, identity };
  }

  const url = new URL(originCloudUrl);
  const params = [...url.searchParams.entries()];
  const emptySlotIndex = params.findLastIndex(([, value]) => value === '');
  if (emptySlotIndex === -1) {
    throw new Error(
      'Origin cloud URL has a query string but no empty parameter to receive the charge point identity ' +
        '(expected something like "...?sn=") - paste the URL exactly as shown by the vendor app.',
    );
  }
  params[emptySlotIndex] = [params[emptySlotIndex][0], identity];

  const endpointUrl = new URL(originCloudUrl);
  endpointUrl.search = '';

  return {
    // ocpp-rpc re-adds the '/' before the identity segment; strip a trailing
    // one here to avoid a double slash on the wire.
    endpoint: endpointUrl.toString().replace(/\/$/, ''),
    // Neutralized: the WHATWG URL parser collapses a trailing "/." segment,
    // so the real identity only ever reaches the origin cloud via `query`.
    identity: '.',
    query: Object.fromEntries(params),
  };
}
