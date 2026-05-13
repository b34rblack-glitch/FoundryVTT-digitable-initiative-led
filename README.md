# DigiTable - Initiative LED (Foundry VTT v14)

A Foundry VTT module that drives a [WLED](https://kno.wled.ge/) LED strip from your combat turn order. The strip becomes a physical initiative tracker for a table-based game: each player has a "seat" on the strip, and during combat the active combatant's seat lights up in one color while the on-deck combatant's seat lights up in another.

> **Fork notice.** This is a fork of [mcules/FoundryVTT-digitable-initiative-led](https://github.com/mcules/FoundryVTT-digitable-initiative-led). All the original hardware design, idea, and v0.x–v1.0 implementation are by **McUles** — the original repository had been inactive for ~3 years and stopped working on modern Foundry, so this fork picks the work back up. Huge thanks to McUles for the project; if you got value from this module, please go star the upstream too.
>
> This fork adds Foundry VTT v14 compatibility, a configurable per-seat LED layout (variable LED count per seat, addressable by explicit ranges), and a "next combatant" highlight in addition to the current-combatant one.

## Hardware

You need:

- An ESP8266 or ESP32 flashed with the [WLED firmware](https://kno.wled.ge/basics/getting-started/).
- An addressable LED strip wired to it. The original setup used an SK6812 strip with six LEDs; any WLED-supported strip and LED count works — you'll tell the module which LEDs belong to which seat.
- The WLED controller must be reachable on the same network as the machine that runs Foundry (the host that opens the world and runs the active GM session).

Once your WLED is on the network and reachable via its IP/hostname, you're ready to configure the module.

## Installation

### Recommended: install via manifest URL

1. In Foundry's setup screen open **Add-on Modules → Install Module**.
2. Paste this manifest URL into the **Manifest URL** field at the bottom and click **Install**:
   ```
   https://github.com/b34rblack-glitch/FoundryVTT-digitable-initiative-led/raw/main/module.json
   ```
3. Enable the module inside your world from **Game Settings → Manage Modules**.

### Manual install

1. Clone or download this repository into the `modules` directory of your Foundry VTT installation:
   ```
   git clone https://github.com/b34rblack-glitch/FoundryVTT-digitable-initiative-led
   ```
2. Restart your Foundry VTT server.

## Setup

### 1. Point the module at your WLED controller

**Game Settings → Configure Settings → DigiTable - Initiative LED → WLED IP Address.** Enter the controller's IP (e.g. `192.168.1.50`).

### 2. Define your seats

Click **Configure seats** (also under the module's settings tab). The form lets you describe how your physical strip is laid out:

| Column     | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| Seat N     | Stable index used to link an actor to a seat. Edit the other fields, not this label.     |
| Name       | Optional label — e.g. `GM`, `Alice`, `Tank Spot`. Cosmetic; only shown in this dialog.   |
| First LED  | The first LED index this seat owns on the strip (0-based).                              |
| Last LED   | The last LED index this seat owns. Inclusive on both ends.                              |

The example from the project description:

```
Seat 0   GM       First: 0    Last: 15      → 16 LEDs (0…15) light up for the GM
Seat 1   Alice    First: 16   Last: 20      → 5 LEDs  (16…20) light up for Alice
Seat 2   Bob      First: 21   Last: 25      → 5 LEDs  (21…25) light up for Bob
```

You can:

- Click **Add seat** to append a new seat (the new row's range auto-starts one LED after the highest existing `Last LED`).
- Click the trash icon on any row to remove that seat.
- Pick the **Current turn color** (default red) and **Next turn color** (default yellow). They apply globally — every seat uses the same two colors, driven by who's "up" and who's "on deck".
- Use **Reset to defaults** to start over (six seats, one LED each).

The dialog shows a live **Strip length** counter — the highest `Last LED + 1` across all seats. This is the smallest strip your config will address. If your WLED controller has more LEDs than that, the extras stay dark.

LEDs that no seat covers stay dark. Overlapping ranges are allowed; the "current" highlight always wins over "next" if both colors would touch the same LED.

### 3. Assign actors to seats

In the **Actor Directory** (left sidebar), GMs see a new fist icon ✊ next to each actor. Click it to assign that actor to a seat number. Actors without an assigned seat won't light any LEDs during their turn.

### 4. Run combat

That's it. With a combat tracker open:

- **Start combat** → strip powers on, all LEDs dark.
- **Each turn change** → the current combatant's seat lights up in the "current" color, the next combatant's seat lights up in the "next" color. `nextCombatant` skips defeated combatants and wraps the round.
- **End combat** → strip powers off.

WLED commands are issued from the active GM client only, so players don't all hammer your controller.

## Troubleshooting

- **Nothing happens when combat starts** — check that the WLED IP setting is filled in and the controller is reachable (`http://<ip>/` should load WLED's UI in your browser).
- **Mixed-content blocked in the browser** — if you serve Foundry over HTTPS, the browser will refuse to call `http://` WLED endpoints. Run Foundry on plain HTTP on the LAN, or front WLED with an HTTPS proxy.
- **A whole stretch of LEDs stays dark mid-combat** — that range isn't claimed by any seat. Open **Configure seats** and either grow a seat's range or add a new seat to cover it.
- **The "next" LED is wrong** — Foundry's `Combat#nextCombatant` skips defeated combatants. If you want a different rule, raise an issue.

## Credits

- **Original module and concept:** [McUles](https://github.com/mcules) — the original [mcules/FoundryVTT-digitable-initiative-led](https://github.com/mcules/FoundryVTT-digitable-initiative-led) lay dormant for ~3 years; this fork updates it for current Foundry and adds the configurable seat layout.
- **WLED firmware:** [WLED](https://kno.wled.ge/).

## License

Inherits the original repository's license. Use, modify, and share freely.
