# Gladys OCPP integration

External integration for [Gladys Assistant](https://gladysassistant.com):
read-only supervision of any number of OCPP 1.6J charge points, each relayed
through an embedded, companion OCPP relay to its own vendor cloud.

User-facing documentation: [`docs/en.md`](./docs/en.md) /
[`docs/fr.md`](./docs/fr.md).

## Scope

- Protocol: **OCPP 1.6J only.** The relay negotiates the `ocpp1.6` WebSocket
  subprotocol and its message parsing is written against OCPP 1.6 message
  shapes (`gateway/src/gateway.ts`, `gateway/src/ocpp16.ts`).
- Mode: **read-only supervision.** No `onSetValue` handler is registered;
  the integration never sends a command to a charge point.
- One Gladys device per charge point, one feature group per physical
  connector.
- Requires **Gladys `>=4.85.0`** (`gladys-assistant-integration.json`).

## Architecture

Two containers, declared in `gladys-assistant-integration.json`:

| Container        | Role                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| main (repo root) | SDK wiring: publishes devices/states to Gladys, starts/polls the `gateway` sub-container, handles the `add_charger` action. Never speaks OCPP directly.              |
| `gateway`        | OCPP relay. Runs an `RPCServer` (charge points) and one `RPCClient` per relayed charge point (each origin cloud). Exposes a private HTTP API for the main container. |

```
Charge point ──OCPP 1.6J WebSocket──> gateway (RPCServer)
                                          │
                                          ├──OCPP 1.6J WebSocket──> origin cloud (RPCClient, once configured)
                                          │
                                          └──internal HTTP (private network)──> main container
                                             GET /api/state, GET /api/events (SSE), POST /api/chargers
```

A charge point with no configured origin cloud is answered locally by the
gateway (`gateway/src/localMode.ts`) instead of being relayed.

## Project structure

```
.
├─ index.js                          # SDK bootstrap, gateway lifecycle, event stream, add_charger action
├─ src/
│  ├─ config.js                      # config defaults + normalization
│  ├─ chargers.js                    # charger store: parse/serialize/upsert/remove
│  ├─ gatewayClient.js               # HTTP client for the gateway sub-container
│  ├─ stateSync.js                   # outbound state queue (coalescing + rate limiting)
│  └─ devices/
│     ├─ index.js                    #   device blueprint registry
│     └─ charger.js                  #   charge point device: features, discovery, state mapping
├─ gateway/                          # standalone sub-project: the OCPP relay sub-container
│  ├─ src/
│  │  ├─ gateway.ts                  #   RPCServer / RPCClient wiring
│  │  ├─ chargerRegistry.ts          #   identity -> origin cloud URL map
│  │  ├─ localMode.ts                #   synthesized responses for unconfigured charge points
│  │  ├─ originConnection.ts         #   path-segment vs. query-string identity addressing
│  │  ├─ observe.ts                  #   OCPP message -> internal state updates
│  │  ├─ changeFeed.ts               #   change notifications pushed over SSE
│  │  ├─ state.ts                    #   ChargerState / ConnectorState / StateStore
│  │  ├─ meterValues.ts              #   OCPP MeterValues -> ConnectorState mapping
│  │  ├─ ocpp16.ts                   #   OCPP 1.6 message types (TypeScript only)
│  │  ├─ exchangeLog.ts              #   relayed-exchange log formatting
│  │  └─ stateApi.ts                 #   internal HTTP API (GET /api/state, GET /api/events, POST /api/chargers)
│  ├─ test/                          #   node:test, own package.json/tsconfig.json
│  └─ Dockerfile                     #   sub-container image
├─ test/                             # main container tests (node:test)
├─ docs/
│  ├─ en.md / fr.md                  # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest
├─ Dockerfile                        # main container image
├─ .github/workflows/                # CI: builds + publishes both images
└─ cover.png                         # catalog cover image
```

## Gladys device model

- One device per charge point (external_id: `charger-station:<OCPP identity>`).
- One feature group per physical connector, connector `0` (aggregate)
  excluded. Each connector reports 6 features:
  - `connector-status` and `charging-state` (`charging-station` category)
  - `power`, `current`, `voltage`, `energy` (`energy-sensor` category)
- Feature `external_id` shape: `<feature key>:<evse id>:<connector id>`
  (e.g. `connector-status:1:1`); `evse id` is currently always `1`.
- Each device carries its configured origin cloud URL as a device `param`.

## Configuration

- `config_schema` renders a fixed walkthrough (no editable fields).
- The origin cloud URL for a charge point is set via the `add_charger`
  manifest action, which picks the charge point from a `select` populated
  with existing Gladys devices.
- The set of configured charge points is stored in free-form config
  (`chargers_json`, see `src/chargers.js`) and pushed live to the gateway
  (`POST /api/chargers`) — no container restart required.

## Tested hardware

| Charge point         | Protocol  | Identity addressing   | Connectors |
| -------------------- | --------- | --------------------- | ---------- |
| Autel MaxiCharger AC | OCPP 1.6J | Query-string (`?sn=`) | 1          |

## Run the main container locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="ocpp-gateway" \
LOG_LEVEL=debug \
npm start
```

## Run the gateway sub-container locally

```bash
cd gateway
npm install
GATEWAY_PORT=9321 UI_PORT=9080 npm start
```

Configure a charger: `POST http://localhost:9080/api/chargers` with body
`{"chargers": {"<identity>": "<origin cloud url>"}}`.

## Quality checks

```bash
npm run format:check   # Prettier (covers gateway/**/*.ts too)
npm run format
npm run lint            # ESLint, main container only
npm test                # Main container tests

cd gateway
npm run typecheck        # tsc --noEmit
npm test                 # Gateway sub-container tests
```

Runs automatically on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

Fork, edit, add the `gladys-assistant-integration` GitHub topic, release
from the Actions tab. The release workflow bumps `package.json` and
`gladys-assistant-integration.json` version fields and publishes both
container images (main + `gateway/`) in lockstep.

## Requirements

- Node.js `>=20` for the main container.
- Node.js 24 for the `gateway/` sub-project (TypeScript run natively, no
  build step).
- `@gladysassistant/integration-sdk` `^0.11.0`.

## License

Apache-2.0
