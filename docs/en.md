# OCPP EV Charger Gateway

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration
screen (in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## Scope of this version

**Read-only supervision, nothing else.** This integration observes an OCPP
1.6 EV charge point and shows its state in Gladys (status, plugged, charging,
power, current, voltage, total energy) — there is no way to start, stop, or
limit a charge from Gladys yet.

## How it works

The integration runs its own OCPP relay in a companion container: your
charge point connects directly to a port Gladys assigns, and the relay
forwards everything to your charger vendor's own cloud, so the charger keeps
working exactly as before — nothing about the vendor's service is changed or
replaced. The relay only _observes_ what passes through it to build the
state shown in Gladys; it never invents or withholds anything on the wire.

## Prerequisite

Your charge point's vendor app or portal must let you view and change the
OCPP server URL the charger connects to. Not every vendor exposes this — if
yours doesn't, this integration cannot be used.

**Before changing anything, write down the OCPP server URL currently shown
by your vendor app.** It is the only way back to the vendor's own cloud if
you ever want to stop using this integration.

## Setup

1. Open the **Configuration** tab of the integration.
2. Paste the **origin cloud URL** exactly as shown by your vendor app,
   including any trailing query string (some vendors end their URL in
   something like `?sn=`).
3. Save. The integration starts its relay (a companion container) and
   reports its status.
4. Open the integration's supervision block to find the **host port**
   assigned by Gladys for the `gateway` sub-container's OCPP port (an "Open"
   / port label next to the `gateway` entry). This is also echoed in the
   integration's connection status message.
5. In your charge point's vendor app, point its OCPP server URL to
   `ws://<this-Gladys-host's-LAN-address>:<assigned-port>/` — standard OCPP
   addressing (the charge point identifies itself in the URL path, the same
   way it always has). Any query-string quirk on the _vendor's_ side (step 2)
   only concerns the relay's outbound connection to the vendor cloud — it is
   invisible to your charge point.
6. Go to the **Discovery** tab: once the charge point has connected and sent
   its first status updates, its connector(s) appear there, ready to be
   added as devices.

## Multiple connectors

If your charge point has more than one physical connector, each one becomes
its own device in Gladys as soon as it has reported its status at least
once. If a connector doesn't appear yet, try **Rescan** from the Discovery
tab after using that connector.

## Security note

Exposing the relay's OCPP port makes it reachable by anything on your LAN,
without authentication — this is inherent to how OCPP charge points connect
to a server. The relay only ever _observes_ what passes through it and never
makes decisions on its own (it never invents a transaction, never authorizes
a charge): at worst, a rogue device on your LAN could feed misleading data
into this integration's view, but it cannot affect your real charge point,
which keeps its own independent connection to the vendor's cloud through the
relay. Keep this in mind on a shared or untrusted network.

## Known limitations (this version)

- **One charge point per installed instance.** If you have several charge
  points, install the integration once per charger.
- **The relay's state resets on restart** (host reboot, changing the origin
  cloud URL, or a crash): it only remembers what it has seen since it last
  started. This does not delete any device you already created in Gladys —
  it just means fresh data returns only once the charge point reconnects and
  sends its status again (normally within seconds).
- **No control from Gladys.** Starting, stopping, or limiting a charge is not
  possible in this version.

## Troubleshooting

Check the integration's logs from the Gladys UI (supervision block →
container selector) for the main container and, separately, for the
`gateway` sub-container — that is where the OCPP relay itself logs every
connection, disconnection, and relayed message.
