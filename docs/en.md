# Charger Station

**Read-only supervision.** This integration observes any
number of OCPP 1.6 charge points and shows their state in Gladys
(connector status, charging state, power, current, voltage, total energy) —
there is no way to start, stop, or limit a charge from Gladys yet.

## How it works

```mermaid
flowchart LR
    CP(["Charge point"]) <-->|OCPP, WebSocket| Relay["OCPP relay"]
    Relay <-->|OCPP, forwarded| Cloud[("Vendor cloud")]
    Relay <-.->|state and config, HTTP| Gladys[("Gladys")]
```

The integration runs its own OCPP relay. Every charge point connects to the
**same** URL — the relay tells them apart by the identity each one
announces on connection. The moment a charge point points at that URL (see
Setup below), the relay supervises it **automatically**, with no need to
declare it in Gladys first: it answers it normally, so charging itself
keeps working. But until you attach it to **its own** origin cloud, that
cloud is completely out of the loop — nothing that goes through the
vendor's app (remote start/stop, live status, charge history) works during
that window, since the vendor's backend has no connection to the charge
point at all. Attaching the origin cloud changes that: the relay then also
forwards the charge point's traffic there, and the vendor's app works
exactly as before again. The relay only _observes_ what passes through it
to build the state shown in Gladys; it never invents or withholds anything
on the wire, in either mode.

## Prerequisites

**Gladys 5.1.0 or later.** The charge point state is published using
Gladys's charging-station device features, and the dashboard widget relies on
integration widgets — older versions don't know about either.

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
   with the one shown in the walkthrough on the integration's
   **Configuration** screen — it's filled in for you, address and port
   included. The same URL works for **every** charge point.
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
across those two: `Preparing` and `Finishing` both show as "Occupied /
Vehicle connected" (a vehicle is physically connected in both cases),
`Charging` as "Occupied / Charging", and `SuspendedEV`/`SuspendedEVSE` as
"Occupied / Paused (vehicle)"/"Occupied / Paused (charger)". When no session
is in progress, the charging state reads _Idle_. Both features stay empty
until the charge point
has reported its status at least once.

Values update **as they happen**, within a few seconds: the relay tells the
integration about every change it observes rather than being asked at
intervals. A charge point that connects for the first time also appears in
Discovery on its own, without waiting for a refresh.

## Dashboard widget

Add a **Charge point** box to a dashboard and pick the charge point. A widget
shows **one connector** (connector 1 by default): for a charge point with
several connectors, add one widget per connector.

At the top, the widget always says what the connector is doing right now, in
plain words, with the session duration while charging. The rest is up to the
widget settings:

| Setting                       | Default                                       | Effect                                                                                                                                                          |
| ----------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connector**                 | 1                                             | The connector shown.                                                                                                                                            |
| **Tiles**                     | Power, Session energy, Session duration, Cost | Any of: live power, energy and duration of the current session (or of the last one when idle), cost, max power offered by the charge point, meter total energy. |
| **Chart**                     | Automatic                                     | _Automatic_: power curve while charging, energy of the recent sessions otherwise. Or always one of them, or none.                                               |
| **Power curve period**        | Last 12 hours                                 | From the last hour to the last week.                                                                                                                            |
| **Price per kWh (€)**         | empty                                         | See "Cost" below.                                                                                                                                               |
| **Show charge point details** | yes                                           | Connector status, limit offered by the charge point, error code if any, last message to the relay, vendor and model.                                            |

A tile with nothing to show yet (no session, for instance) is hidden. A widget
has limited room: with both the chart **and** the details, only the first 5
selected tiles are shown.

### Cost

- **If Gladys's Energy screen is set up** (charge point attached to your
  electricity meter, contract filled in), the tile shows the **cost of the
  last 30 minutes**, computed by Gladys with your contract (peak/off-peak
  hours, Tempo…). Gladys computes these costs in the background: the tile
  appears after the first run and may lag behind by up to half an hour. If the
  charge point was created before this version, click **Update** on its
  device card first.
- **Otherwise, if you entered a price per kWh**, the tile shows the **session
  cost** (session energy × that fixed price, no peak/off-peak hours).
- **Otherwise**, no cost tile.

Recent sessions are kept by the relay in memory: the list starts over when the
integration restarts.

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
