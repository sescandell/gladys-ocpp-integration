# Gladys OCPP integration

External integration for [Gladys Assistant](https://gladysassistant.com):
read-only supervision of an OCPP 1.6 EV charge point, relayed through an
embedded, companion OCPP relay to the charger's own vendor cloud. Built with
the JavaScript SDK
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
Charge point (OCPP 1.6J)
        |
        v
┌── sub-container "gateway" (gateway/) ──┐
│ RPCServer <-> RPCClient relay to the   │
│ configured origin cloud URL, passive   │
│ observation only, never decisional     │
└─────────────────────────────────────────┘
        ^  internal HTTP (private network, DNS alias "gateway")
        |
┌── main container (this repo's root) ───┐
│ SDK wiring: starts/polls the gateway,  │
│ publishes device(s)/states to Gladys   │
└─────────────────────────────────────────┘
```

## Project structure

```
.
├─ index.js                          # SDK bootstrap + gateway sub-container lifecycle
├─ src/
│  ├─ config.js                      # config defaults + normalization
│  ├─ gatewayClient.js               # HTTP client + lifecycle guard for the "gateway" sub-container
│  └─ devices/
│     ├─ index.js                    #   registry (single blueprint, see below)
│     └─ charger.js                  #   one device per physical connector, discovered dynamically
├─ gateway/                          # standalone sub-project: the OCPP relay sub-container
│  ├─ src/
│  │  ├─ gateway.ts                  #   RPCServer (charge point) <-> RPCClient (origin cloud)
│  │  ├─ originConnection.ts         #   generic path-segment vs. query-string identity addressing
│  │  ├─ observe.ts                  #   OCPP message -> internal state updates
│  │  ├─ state.ts                    #   ChargerState / ConnectorState / StateStore
│  │  ├─ meterValues.ts              #   OCPP MeterValues -> ConnectorState mapping
│  │  ├─ ocpp16.ts                   #   OCPP 1.6 message types (TypeScript only)
│  │  └─ stateApi.ts                 #   internal-only GET /api/state (polled by gatewayClient.js)
│  ├─ test/                          #   node:test, own package.json/tsconfig.json
│  └─ Dockerfile                     #   sub-container image
├─ docs/
│  ├─ en.md / fr.md                  # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest (config_schema + the "gateway" sub-container declaration)
├─ Dockerfile                        # main container image, Node 24 Alpine, read-only rootfs
├─ .github/workflows/                # CI: builds + publishes BOTH images (main + gateway)
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

## Dynamic multi-connector discovery

A charge point can have several physical connectors. Rather than assuming a
fixed count, `src/devices/charger.js`'s `buildDevices()` asks the gateway
sub-container for whatever connectors it has actually observed
(`StatusNotification`) since it last started, and offers one Gladys device
per connector (OCPP connector `0`, the aggregate charge point, is always
excluded). The set naturally grows as new connectors report in; Gladys's
discovery model handles this cleanly since `publishDiscoveredDevices`
replaces the whole offered list on every call, not just the delta.

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
GATEWAY_PORT=9321 UI_PORT=9080 ORIGIN_CLOUD_URL="wss://your-charger-vendor-cloud/..." npm start
```

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
