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

## Prerequisite

Each charge point's vendor app or portal must let you view and change the
OCPP server URL it connects to. Not every vendor exposes this — if yours
doesn't, this integration cannot be used for that charge point.

**Before changing anything, write down the OCPP server URL currently shown
by the vendor app.** It is the only way back to the vendor's own cloud if
you ever want to stop using this integration for that charger.

## Setup

No required order: point a charge point at the relay whenever you like,
before or after configuring it. It shows up in Discovery the moment it
connects, whether or not it has an origin cloud yet.

1. Install the integration — its relay starts automatically, no
   configuration needed yet.
2. Open the integration's **Supervision** screen: the connection status
   shows a ready-to-use OCPP URL, `ws://<this Gladys host's LAN
address>:<port>/` — the port is already filled in for you, just replace
   the placeholder with this Gladys host's actual LAN address. This URL is
   the **same for every charge point**.
3. In the charge point's vendor app, point its OCPP server URL there. It
   connects right away and shows up in the **Discovery** tab, ready to be
   created as a device — its real status (plugged, charging, etc.) is
   already supervised even though it isn't relayed to any cloud yet.
4. Whenever you're ready to route it to its real cloud instead: find the
   charge point's **identity** (sometimes called serial number or charge
   point ID — shown on its Discovery/device card, in its vendor app, or on a
   label on the charger) and run the **"Add a charge point"** action
   (Configuration screen) with that identity and the **origin cloud URL**
   exactly as shown by the vendor app — including any trailing query string
   some vendors use (e.g. ending in `?sn=`). Any such quirk only concerns
   the relay's outbound connection to that vendor's cloud — it is invisible
   to the charge point itself. The charge point reconnects automatically
   within a few seconds and starts relaying instead of just being
   supervised locally. Its configured origin cloud URL is then shown right
   on its card (Discovery, then the device once created) — that's the only
   place to check it, there is no list of configured charge points anywhere
   else.
5. Repeat step 4 for every other charge point you want relayed — same URL,
   its own identity, its own origin cloud URL, even a different vendor.

To fix a mistake or change a charge point's origin cloud URL, run the action
again with the same identity and the corrected URL (check its current URL
on its device card first). To detach a charge point from its cloud and put
it back into local-only supervision, run the action with its identity and
an **empty** URL — takes effect the next time that charge point reconnects
(it keeps relaying through its current connection until then).

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
