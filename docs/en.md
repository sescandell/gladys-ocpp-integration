# Charger Station

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration
screen (in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## Scope of this version

**Read-only supervision, nothing else.** This integration observes any
number of OCPP 1.6 charge points and shows their state in Gladys
(connector status, charging state, power, current, voltage, total energy) —
there is no way to start, stop, or limit a charge from Gladys yet.

## How it works

The integration runs its own OCPP relay in a companion container, started
automatically on install. Every charge point connects to the **same** URL —
the relay tells them apart by the identity each one announces on
connection. A charge point doesn't need to be configured to connect: the
relay supervises **any** connecting charge point locally right away
(answers it normally, observes its real status), and only forwards its
traffic to **its own** configured origin cloud once you've attached one
(see Setup below) — so every charger keeps working exactly as before,
nothing about any vendor's service is changed or replaced. The relay only
_observes_ what passes through it to build the state shown in Gladys; it
never invents or withholds anything on the wire, in either mode.

## Prerequisites

**Gladys 4.85.0 or later.** The charge point state is published using
Gladys's charging-station device features, which older versions don't know
about (they would refuse to create the device).

Each charge point's vendor app or portal must let you view and change the
OCPP server URL it connects to. Not every vendor exposes this — if yours
doesn't, this integration cannot be used for that charge point.

**Before changing anything, write down the OCPP server URL currently shown
by the vendor app.** It is the only way back to the vendor's own cloud if
you ever want to stop using this integration for that charger.

## Setup

Five steps, once per charge point. Nothing is lost along the way: the charge
point keeps its own connection to the vendor's cloud, Gladys simply sits in
the middle and watches.

1. **Write down the OCPP server URL** your charge point currently uses, from
   its vendor app. This is your only way back to the vendor's cloud — keep
   it somewhere safe.
2. **Point the charge point at Gladys**: in that same app, replace the URL
   with the one shown on the integration's **Supervision** screen —
   `ws://<your Gladys address>:<port>/`. The port is filled in for you;
   the address is the one you use to reach Gladys. The same URL works for
   **every** charge point.
3. **Add it to Gladys**: it connects immediately and appears in the
   **Discovery** tab, already supervised. Add it from there.
4. **Give it back its cloud**: on the Configuration screen, run the
   **"Add a charge point"** action, pick it from the list, and paste the URL
   from step 1 — exactly as the vendor app showed it, including any trailing
   query string some vendors use (e.g. ending in `?sn=`).
5. **Done.** The charge point reconnects on its own within seconds and
   carries on talking to its vendor's cloud exactly as before, through
   Gladys — which now follows it live.

Repeat for every other charge point: same Gladys URL, its own vendor URL,
even a different vendor.

To fix a mistake or change a charge point's origin cloud URL, run the action
again for the same charge point with the corrected URL (check its current
URL on its device card first). To detach a charge point from its cloud and
put it back into local-only supervision, run the action for it with an
**empty** URL — takes effect the next time that charge point reconnects (it
keeps relaying through its current connection until then).

If you **delete** a charge point's device from Gladys while it still has an
origin cloud configured, it disappears from the picker and the action can no
longer change it — the relay keeps using that cloud. Add the device back
from Discovery to regain control of it.

## Starting over

Uninstalling the integration removes everything it created: its devices, its
stored configuration, and the relay's own container and data. Nothing is left
behind, so reinstalling starts genuinely fresh.

To go back to your vendor's cloud directly, put the URL you noted in step 1
back into the charge point's app — it stops going through Gladys at its next
reconnection.

## What you see on a charge point

Each connector reports two state features, plus its measurements (power,
current, voltage, total energy):

- **Status** — what the connector itself is doing: _Available_, _Occupied_,
  _Reserved_, _Unavailable_, _Faulted_.
- **Charging state** — what the session is doing: _Charging_, _Vehicle
  connected_, _Paused (vehicle)_, _Paused (charger)_, _Idle_.

OCPP 1.6 charge points report a single, more detailed status, which is split
across those two: `Preparing` shows as "Occupied / Vehicle connected",
`Charging` as "Occupied / Charging", `SuspendedEV` and `SuspendedEVSE` as
"Occupied / Paused (vehicle)" and "Occupied / Paused (charger)", and
`Finishing` as "Occupied / Idle". When no session is in progress, the
charging state reads _Idle_. Both features stay empty until the charge point
has reported its status at least once.

Values update **as they happen**, within a few seconds: the relay tells the
integration about every change it observes rather than being asked at
intervals. A charge point that connects for the first time also appears in
Discovery on its own, without waiting for a refresh.

## Multiple connectors

A charge point is one device in Gladys, whatever its number of physical
connectors. It starts with one connector's worth of features (status,
charging state, power, current, voltage, energy); if it has more than
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
  charge points briefly disappear until they reconnect (normally within
  seconds); this does not delete any device you already created in Gladys.
- **Starting a charge session while a charge point is still locally
  supervised (no origin cloud attached yet), then attaching a cloud mid-session:**
  the charge point may keep referencing the session it started locally once
  it reconnects into relay mode, which the real origin cloud never saw. A
  rare overlap in practice (attaching a cloud is usually done once, right
  after first connecting) — if it happens, the affected session's data may
  not reach the origin cloud correctly; the next session is unaffected.
- **No control from Gladys.** Starting, stopping, or limiting a charge is not
  possible in this version.

## Troubleshooting

Check the integration's logs from the Gladys UI (supervision block →
container selector) for the main container and, separately, for the
`gateway` sub-container — that is where the OCPP relay itself logs every
connection, disconnection, and relayed message (full payload, both
directions) for every charge point.
