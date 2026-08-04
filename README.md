# Gladys OCPP integration

External integration for [Gladys Assistant](https://gladysassistant.com):
read-only supervision of any number of OCPP 1.6 EV charge points, each
relayed through an embedded, companion OCPP relay to its own vendor cloud —
even different vendors at once. Built with the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
from the official
[`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

User-facing documentation (setup, security notes, limitations):
[`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md).

## Why two containers

A Gladys external integration's main container can never publish a network
port — its only inbound channel is an outbound connection to Gladys itself.
To let a physical charge point connect to this integration over the LAN, the
OCPP relay lives in a declared **companion sub-container** (the manifest's
`containers` field), the only mechanism Gladys provides for this. The main
container never speaks OCPP directly: it only starts/supervises the relay
sub-container through the SDK and polls its internal state over HTTP.

```
Charge point A ─┐                     Charge point B ─┐
(OCPP 1.6J)      │                     (OCPP 1.6J)      │
                 v  same port                          v
┌── sub-container "gateway" (gateway/) ───────────────────┐
│ RPCServer <-> one RPCClient per RELAYED charge point,   │
│ routed by real OCPP identity (ChargerRegistry); an      │
│ unconfigured one is answered locally instead (no cloud  │
│ yet - localMode.ts) - passive observation either way,   │
│ never decisional                                        │
└───────────────────────────────────────────────────────────┘
        ^  internal HTTP (private network, DNS alias "gateway")
        |  GET /api/state, POST /api/chargers (live map sync)
┌── main container (this repo's root) ───┐
│ SDK wiring: starts/polls the gateway,  │
│ publishes device(s)/states to Gladys,  │
│ add_charger action configures routing  │
└─────────────────────────────────────────┘
```

## Project structure

```
.
├─ index.js                          # SDK bootstrap, gateway lifecycle, add_charger/reset_all actions
├─ src/
│  ├─ config.js                      # config defaults + normalization (folds in `chargers`)
│  ├─ chargers.js                    # free-config charger store: parse/serialize/upsert/remove
│  ├─ gatewayClient.js               # HTTP client for the "gateway" sub-container (state, live map sync)
│  └─ devices/
│     ├─ index.js                    #   registry (single blueprint, see below)
│     └─ charger.js                  #   one device per configured charge point (connectors are features)
├─ gateway/                          # standalone sub-project: the OCPP relay sub-container
│  ├─ src/
│  │  ├─ gateway.ts                  #   RPCServer (charge points) <-> RPCClient (each origin cloud)
│  │  ├─ chargerRegistry.ts          #   live identity -> origin cloud URL map
│  │  ├─ localMode.ts                #   synthesized "everything is fine" responses, no origin cloud yet
│  │  ├─ originConnection.ts         #   generic path-segment vs. query-string identity addressing
│  │  ├─ observe.ts                  #   OCPP message -> internal state updates
│  │  ├─ state.ts                    #   ChargerState / ConnectorState / StateStore
│  │  ├─ meterValues.ts              #   OCPP MeterValues -> ConnectorState mapping
│  │  ├─ ocpp16.ts                   #   OCPP 1.6 message types (TypeScript only)
│  │  ├─ exchangeLog.ts              #   formats one relayed OCPP exchange as a stdout line
│  │  └─ stateApi.ts                 #   internal-only GET /api/state, POST /api/chargers
│  ├─ test/                          #   node:test, own package.json/tsconfig.json
│  └─ Dockerfile                     #   sub-container image
├─ docs/
│  ├─ en.md / fr.md                  # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest (config_schema + add_charger/reset_all actions + "gateway" sub-container)
├─ Dockerfile                        # main container image, Node 24 Alpine, read-only rootfs
├─ .github/workflows/                # CI: builds + publishes BOTH images (main + gateway)
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

## Dynamic multi-charger discovery, one device per charge point

A charge point does NOT need to be configured to be discovered: the gateway
accepts any connection and answers it as a permissive, "everything is fine"
local CSMS (`gateway/src/localMode.ts`) - no origin cloud, but real state
IS observed (status, meter values) into the same store relay mode uses. So
it shows up in Discovery the moment it connects, whether or not it has an
origin cloud yet - genuinely automatic, the same reason any other
integration's discovered devices show up.

The origin cloud URL is attached separately, at any time, via the
`add_charger` manifest action (identity + origin cloud URL) - `config_schema`
is a flat, fixed list of fields, it cannot represent "add as many charge
points as you want", so the set lives in free internal config storage
(`src/chargers.js`, key `chargers_json`) instead, pushed live to the gateway
sub-container (`POST /api/chargers`, see `gateway/src/stateApi.ts`) - no
container restart needed to add, update, or remove one. The moment a
previously-unconfigured identity gets a URL, `stateApi.ts` force-closes
that ONE charge point's live connection (`gateway.ts`'s `localClients` map,
since `ocpp-rpc` exposes no identity-keyed lookup of its own connections) -
it reconnects and this time resolves to full relay mode. Removing a charge
point's URL takes effect on its next reconnection, not retroactively (an
already-relaying session isn't interrupted).

A separate `reset_all` action (confirmation-gated, "type RESET") clears
`chargers_json` entirely and calls `gladys.restartContainer('gateway')` -
the only way to drop a live RELAY-mode connection too (unlike local-mode
ones, those aren't tracked in any identity-keyed map `stateApi.ts` could
force-close individually), giving every charge point a clean local-mode
re-detection on reconnect. It cannot delete devices already created in
Gladys - the SDK has no such call - uninstalling/reinstalling the
integration is the actual full reset (it removes devices, config, and the
sub-container's own data, verified in Gladys core's
`externalIntegration.uninstall.js`); `reset_all` exists for iterating
without that round-trip.

`src/devices/charger.js`'s `buildDevices()` offers ONE Gladys device per
identity in the union of `config.chargers` (configured) and the gateway's
full observed-state map (includes auto-detected identities too). This
matches the SDK's own discovery contract ("your integration never creates
or deletes devices, it publishes the devices it discovers, and the user
decides which ones to create" - the official dev docs), the same pattern a
cloud/account-based integration uses to list devices from its own registry,
online or not. A charge point can have several physical connectors: each
one is a small group of features on that SAME device (`Connector <n> -
<label>`, OCPP connector `0` - the aggregate charge point - is always
excluded), seeded with connector 1 by default (the OCPP-conventional first,
and for most real hardware only, connector) until the gateway actually
observes more via `StatusNotification`. Growing the feature list of an
already-created device surfaces as an "Update" button in Gladys - the user
stays in control of structural changes.

Each device also carries its configured origin cloud URL as a `param` (not
a `feature` - it's config, not telemetry): Gladys renders a device's
`params` as a plain read-only table on its card, in Discovery _before_
creation and in the device list _after_, silently kept in sync on every
re-publish (no "Update" click needed, unlike a features structure change).
This is the only place a charge point's configured URL is surfaced in the
UI - `config_schema` can't render this open-ended, per-charger data as a
form field (Gladys config forms are a flat, fixed list of fields), and
cramming it into the connection status message (see below) would mix
business config into what reads as an operational/ops caption.

## Generic origin-cloud identity addressing

Some vendor clouds expect the charge point identity in the URL's query
string rather than as a path segment (the OCPP-standard way, and what the
underlying `ocpp-rpc` library does automatically). `gateway/src/originConnection.ts`
detects this **structurally** — from whether the configured origin cloud URL
already has a query string — rather than special-casing any vendor by name.
See that file's header comment for the exact mechanism and a documented
caveat (a one-character trailing-slash artifact on the wire, worth
validating against real hardware).

## Tested hardware

| Charge point         | Protocol  | Identity addressing   | Connectors | Notes                                                                                                         |
| -------------------- | --------- | --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| Autel MaxiCharger AC | OCPP 1.6J | Query-string (`?sn=`) | 1          | End-to-end: relay, live `add_charger` configuration, device discovery all confirmed against the real charger. |

This list only grows as hardware actually gets tested against this repo —
absence from it doesn't mean incompatibility, just that nobody has confirmed
it yet. If you test another charge point successfully (or run into a
firmware quirk `gateway/src/originConnection.ts` doesn't handle), please
open an issue or a PR adding a row here.

## Run the main container locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="ocpp-gateway" \
LOG_LEVEL=debug \
npm start
```

The three `GLADYS_*` variables are injected by the Gladys supervisor when the
integration runs inside its sandboxed container; the SDK reads them
automatically. Note that `reconcileGateway()` (in `index.js`) will fail to
reach a real `gateway` sub-container outside of a full Gladys install — this
mode is mainly useful for exercising the SDK wiring itself.

## Run the gateway sub-container locally

```bash
cd gateway
npm install
GATEWAY_PORT=9321 UI_PORT=9080 npm start
```

No env var is required anymore: the gateway starts with an empty charger
registry and only relays charge points configured live, via
`POST http://localhost:9080/api/chargers` (body `{"chargers": {"<identity>": "<origin cloud url>"}}`)
— exactly what `src/gatewayClient.js`'s `syncChargerMap()` does in production.

## Quality checks

```bash
npm run format:check   # Prettier (covers gateway/**/*.ts too)
npm run format
npm run lint            # ESLint, main container only (gateway/ is TS, see below)
npm test                # Main container: node's built-in test runner

cd gateway
npm run typecheck        # tsc --noEmit
npm test                 # Gateway sub-container: node's built-in test runner
```

These checks run automatically on every push and pull request (see
[`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

Runs the same checks as the store indexer (manifest JSON & schema, Docker
image availability for **both** the main and the `gateway` sub-container
image, cover image, code rules). See the
[integration store](https://github.com/GladysAssistant/integration-store) for
details.

## Publish

Same 5-step flow as any Gladys external integration (fork, edit, add the
`gladys-assistant-integration` GitHub topic, release from the Actions tab).
The release/build workflows here are extended to publish **two** multi-arch
images in lockstep (main + `gateway/`) — see the workflow files for the
exact tagging scheme.

## Notes

- Requires **Node.js ≥ 20** for the main container; the `gateway/`
  sub-project targets Node 24 (matching its Docker image) and TypeScript run
  natively (no build step).
- All external identifiers are prefixed with `ext:<selector>:` — always built
  with `gladys.externalIds(type, platformId)`.
- Replace `cover.png` with a real 800×534 px image (≤150 KB, PNG or JPEG)
  before publishing — the bundled one is a placeholder gradient.
- Double-check `gladys_version` in the manifest against real Gladys server
  release notes before publishing (not verifiable from a dev environment).

## License

Apache-2.0
