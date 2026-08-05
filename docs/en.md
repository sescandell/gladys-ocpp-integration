# OCPP EV Charger Gateway

This is the user documentation of the integration. Gladys re-hosts this file
and shows a permanent **Documentation** link to it in the Configuration
screen (in the user's language, with English as the fallback) — it is when
configuring that the user needs it most.

## Scope of this version

**Read-only supervision, nothing else.** This integration observes any
number of OCPP 1.6 EV charge points and shows their state in Gladys
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

A charge point doesn't need any configuration to connect: point it at the
relay whenever you like and it shows up in Discovery straight away, already
supervised. Attaching its origin cloud comes later, and does require the
charge point to have been added to Gladys first (step 4 below) — that's how
the picker in the action gets its list.

1. Install the integration — its relay starts automatically, no
   configuration needed yet.
2. Open the integration's **Supervision** screen: the connection status
   shows a ready-to-use OCPP URL, `ws://<this Gladys host's LAN
address>:<port>/` — the port is already filled in for you, just replace
   the placeholder with this Gladys host's actual LAN address. This URL is
   the **same for every charge point**.
3. In the charge point's vendor app, point its OCPP server URL there. It
   connects right away and shows up in the **Discovery** tab — its real
   status (available, occupied, charging, etc.) is already supervised even
   though it isn't relayed to any cloud yet.
4. **Add it to Gladys** from the Discovery tab. Beyond creating the device,
   this is what puts the charge point in the picker used by the next step.
5. Whenever you're ready to route it to its real cloud instead: run the
   **"Add a charge point"** action (Configuration screen), **pick the charge
   point from the list**, and enter the **origin cloud URL** exactly as
   shown by the vendor app — including any trailing query string some
   vendors use (e.g. ending in `?sn=`). Any such quirk only concerns the
   relay's outbound connection to that vendor's cloud — it is invisible to
   the charge point itself. The charge point reconnects automatically within
   a few seconds and starts relaying instead of just being supervised
   locally. Its configured origin cloud URL is then shown right on its device
   card — that's the only place to check it, there is no list of configured
   charge points anywhere else.
6. Repeat for every other charge point you want relayed — same URL, its own
   origin cloud URL, even a different vendor.

To fix a mistake or change a charge point's origin cloud URL, run the action
again for the same charge point with the corrected URL (check its current
URL on its device card first). To detach a charge point from its cloud and
put it back into local-only supervision, run the action for it with an
**empty** URL — takes effect the next time that charge point reconnects (it
keeps relaying through its current connection until then).

If you **delete** a charge point's device from Gladys while it still has an
origin cloud configured, it disappears from the picker and the action can no
longer change it — the relay keeps using that cloud. Add the device back
from Discovery to regain control of it, or use the reset below.

## Starting over (debug)

Uninstalling and reinstalling the integration is the clean way to start
completely fresh: it removes every device it created, its stored
configuration, and the relay's own container and data — nothing is left
behind.

To reset without a full reinstall (e.g. while testing), run the **"Reset
everything (debug)"** action (Configuration screen, type `RESET` to
confirm). It clears every configured charge point and restarts the relay
container, wiping its observed state (connectors, live transactions,
history) — every charge point, configured or not, has to reconnect
afterwards and reappears in Discovery as it did the first time. It does
**not** delete devices you already created in Gladys — remove those
manually from the device list if you no longer want them.

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
