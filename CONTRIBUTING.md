# Contributing

How to work on this integration and try it **without a real charge point** and **without
publishing anything**.

## Prerequisites

- Node.js ≥ 20 (the gateway runs TypeScript directly: Node ≥ 24 recommended, like the images).
- Docker (Docker Desktop is fine) for the Gladys test instance.
- PowerShell 7+ to run `dev/install-dev.ps1` (Windows, macOS or Linux).

## 1. Quality checks

Run before every push (CI runs the same, see [`ci.yml`](.github/workflows/ci.yml)):

```bash
npm install
npm run lint            # ESLint (main container + simulator)
npm run format:check    # Prettier, whole repo (npm run format to fix)
npm test                # main container tests

cd gateway
npm install
npm run typecheck       # tsc --noEmit
npm test                # gateway tests

cd ../simulator
npm install
npm test                # simulator tests
```

## 2. Try it with the simulator, no Gladys needed

The [simulator](simulator/README.md) is a fake OCPP 1.6 charge point with a web UI. To watch the
gateway react to it:

```bash
# terminal 1 - the relay
cd gateway && npm install
GATEWAY_PORT=9321 UI_PORT=9080 npm start

# terminal 2 - the fake charge point
cd simulator && npm install
npm start                          # http://127.0.0.1:8088/
```

In the simulator UI, set the URL to `ws://localhost:9321/`, click **Connect**, then plug a vehicle
and start a charge (or run a scenario). The gateway state is at
`http://localhost:9080/api/state`.

## 3. Try it in a real Gladys, on a throwaway instance

To see the integration, the discovery and the dashboard widget in Gladys itself. Everything is
local; nothing is published. Details in [`dev/README.md`](dev/README.md).

```powershell
# a disposable Gladys (>= 5.1) on http://localhost:8080 - create an account on first visit
docker compose -f dev/docker-compose.yml up -d

# build both images locally and install the integration in "dev" mode
./dev/install-dev.ps1 -Email you@example.com

# the fake charge point: set its URL to ws://localhost:<gateway port>/
# (the port is shown in the integration's Supervision screen, or with `docker ps`)
cd simulator && npm install && npm start
```

Then, in Gladys: add the charge point from the **Discovery** tab, and add the "Charge point"
widget to a dashboard.

After changing code, run `./dev/install-dev.ps1` again: it rebuilds the images and updates the
integration in place (devices and settings are kept).

Clean up:

```powershell
docker compose -f dev/docker-compose.yml down -v
docker network rm gladys-integrations   # only if it is left over
```

> **Never point this test instance at the Docker daemon of a machine that already runs a real
> Gladys with external integrations** (typically the home automation box). At startup, Gladys
> force-removes every external-integration container of its Docker daemon that it does not know:
> two Gladys sharing a daemon destroy each other's integrations. Use your development machine, or
> a VM with its own Docker.

## 4. Pull requests

- Keep the main container (`index.js`, `src/`) and the gateway (`gateway/`, TypeScript) separate
  concerns, as described in the [README](README.md#architecture).
- `simulator/` and `dev/` are development tools only: they are not copied into either Docker image
  (explicit `COPY` lines in both `Dockerfile`s, plus the root `.dockerignore`). Keep it that way.
- Add or update tests with the code, and keep `docs/en.md` and `docs/fr.md` in sync when behaviour
  visible to users changes.
- If you touch the manifest (`gladys-assistant-integration.json`), validate it:
  `npx github:GladysAssistant/integration-store .`
