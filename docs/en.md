# OCPP EV Charger Gateway

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration
screen (in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## Scope of this version

**Read-only supervision, nothing else.** This integration observes any
number of OCPP 1.6 EV charge points and shows their state in Gladys (status,
plugged, charging, power, current, voltage, total energy) — there is no way
to start, stop, or limit a charge from Gladys yet.

## How it works

The integration runs its own OCPP relay in a companion container, started
automatically on install. Every charge point connects to the **same** port
Gladys assigns — the relay tells them apart by the identity each one
announces on connection, and forwards each one's traffic to **its own**
configured origin cloud, so every charger keeps working exactly as before —
nothing about any vendor's service is changed or replaced. The relay only
_observes_ what passes through it to build the state shown in Gladys; it
never invents or withholds anything on the wire.

## Prerequisite

Each charge point's vendor app or portal must let you view and change the
OCPP server URL it connects to. Not every vendor exposes this — if yours
doesn't, this integration cannot be used for that charge point.

**Before changing anything, write down the OCPP server URL currently shown
by the vendor app.** It is the only way back to the vendor's own cloud if
you ever want to stop using this integration for that charger.

## Setup

Configure each charge point **before** pointing it at the relay. Most charge
points won't complete a connection to a server that doesn't already know
their identity — a first connection attempt against an unconfigured relay
is typically rejected and not gracefully retried, so getting the order right
matters.

1. Install the integration — its relay starts automatically, no
   configuration needed yet.
2. Find the charge point's **identity** (sometimes called serial number or
   charge point ID) in its vendor app or portal, or on a label on the
   charger itself.
3. Run the **"Add a charge point"** action (Configuration screen): paste the
   identity, and the **origin cloud URL** exactly as shown by that charger's
   vendor app — including any trailing query string some vendors use (e.g.
   ending in `?sn=`). Any such quirk only concerns the relay's outbound
   connection to that vendor's cloud — it is invisible to the charge point
   itself. As soon as the action completes, the charge point shows up in the
   **Discovery** tab, ready to be created as a device — it does not need to
   have connected yet. Its configured origin cloud URL is shown right there
   on its card (and later, once created, on the device itself) — that's the
   only place to check it, there is no list of configured charge points
   anywhere else.
4. Open the integration's **Supervision** screen: the connection status
   shows a ready-to-use OCPP URL, `ws://<this Gladys host's LAN
address>:<port>/` — the port is already filled in for you, just replace
   the placeholder with this Gladys host's actual LAN address. This URL is
   the **same for every charge point**.
5. In the charge point's vendor app, point its OCPP server URL there.
6. Since it is already configured, the charge point connects and starts
   relaying right away — the device created in step 3 starts reporting real
   data.
7. Repeat steps 2-6 for every other charge point — same URL, its own
   identity, its own origin cloud URL, even a different vendor.

To fix a mistake or change a charge point's origin cloud URL, run the action
again with the same identity and the corrected URL (check its current URL
on its device card first). To remove a charge point, run the action with
its identity and an **empty** URL.

If a charge point connects before you've added it here (or with an identity
that doesn't match what you typed), it is rejected and listed as **detected,
awaiting configuration** in the connection status, with the exact identity
it announced — a useful way to catch a typo, but not the intended flow: add
it first, then point it at the relay.

## Multiple connectors

A charge point is one device in Gladys, whatever its number of physical
connectors. It starts with one connector's worth of features (status,
plugged, charging, power, current, voltage, energy); if it has more than
one physical connector, the extra ones appear as additional features
("Connector 2 - ...", etc.) once the gateway has actually seen them report
their status at least once. If you've already created the device, Gladys
shows an **Update** button once new connectors are picked up — nothing is
added silently to a device you already created. If a connector doesn't
appear yet, try **Rescan** from the Discovery tab after using that
connector.

## Security note

Exposing the relay's OCPP port makes it reachable by anything on your LAN,
without authentication — this is inherent to how OCPP charge points connect
to a server. The relay only ever _observes_ what passes through it and never
makes decisions on its own (it never invents a transaction, never authorizes
a charge): at worst, a rogue device on your LAN could feed misleading data
into this integration's view, but it cannot affect a real charge point,
which keeps its own independent connection to its vendor's cloud through the
relay. Keep this in mind on a shared or untrusted network.

## Known limitations (this version)

- **The relay's state resets on restart** (host reboot, a crash): it only
  remembers what it has seen since it last started, including which charge
  points are configured — the integration re-sends the full configured set
  as soon as it reconnects to Gladys, so this self-heals within seconds and
  does not require re-running the action. Freshly restarted, already-known
  charge points briefly disappear from "detected" state until they
  reconnect (normally within seconds); this does not delete any device you
  already created in Gladys.
- **No control from Gladys.** Starting, stopping, or limiting a charge is not
  possible in this version.

## Troubleshooting

Check the integration's logs from the Gladys UI (supervision block →
container selector) for the main container and, separately, for the
`gateway` sub-container — that is where the OCPP relay itself logs every
connection, disconnection, and relayed message (full payload, both
directions) for every charge point.
