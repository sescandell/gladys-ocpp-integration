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
│ RPCServer <-> one RPCClient per charge point, routed to │
│ each one's own origin cloud by its real OCPP identity   │
│ (ChargerRegistry) - passive observation, never decisional│
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
├─ index.js                          # SDK bootstrap, gateway lifecycle, add_charger action
├─ src/
│  ├─ config.js                      # config defaults + normalization (folds in `chargers`)
│  ├─ chargers.js                    # free-config charger store: parse/serialize/upsert/remove
│  ├─ gatewayClient.js               # HTTP client for the "gateway" sub-container (state, live map sync)
│  └─ devices/
│     ├─ index.js                    #   registry (single blueprint, see below)
│     └─ charger.js                  #   one device per (configured charge point x connector)
├─ gateway/                          # standalone sub-project: the OCPP relay sub-container
│  ├─ src/
│  │  ├─ gateway.ts                  #   RPCServer (charge points) <-> RPCClient (each origin cloud)
│  │  ├─ chargerRegistry.ts          #   live identity -> origin cloud URL map + pending identities
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
├─ gladys-assistant-integration.json # manifest (config_schema + add_charger action + "gateway" sub-container)
├─ Dockerfile                        # main container image, Node 24 Alpine, read-only rootfs
├─ .github/workflows/                # CI: builds + publishes BOTH images (main + gateway)
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

## Dynamic multi-charger, multi-connector discovery

Any number of charge points can be configured, one at a time, via the
`add_charger` manifest action (identity + origin cloud URL) — `config_schema`
is a flat, fixed list of fields, it cannot represent "add as many charge
points as you want", so the set lives in free internal config storage
(`src/chargers.js`, key `chargers_json`) instead, pushed live to the gateway
sub-container (`POST /api/chargers`, see `gateway/src/chargerRegistry.ts`) -
no container restart needed to add, update, or remove one.

A charge point can also have several physical connectors. Rather than
assuming a fixed count, `src/devices/charger.js`'s `buildDevices()` asks the
gateway sub-container what it has actually observed (`StatusNotification`)
per configured charge point since it last started, and offers one Gladys
device per (charge point × connector) pair (OCPP connector `0`, the
aggregate charge point, is always excluded). The set naturally grows as new
charge points are configured and new connectors report in; Gladys's
discovery model handles this cleanly since `publishDiscoveredDevices`
replaces the whole offered list on every call, not just the delta.

A charge point connecting with an identity the registry doesn't know yet is
recorded as **pending** and closed cleanly (nothing to relay it to) - its
identity is surfaced in the integration's connection status message so the
user can copy it into the `add_charger` action without hunting for a serial
number on a sticker.

## Generic origin-cloud identity addressing

Some vendor clouds expect the charge point identity in the URL's query
string rather than as a path segment (the OCPP-standard way, and what the
underlying `ocpp-rpc` library does automatically). `gateway/src/originConnection.ts`
detects this **structurally** — from whether the configured origin cloud URL
already has a query string — rather than special-casing any vendor by name.
See that file's header comment for the exact mechanism and a documented
caveat (a one-character trailing-slash artifact on the wire, worth
validating against real hardware).

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
