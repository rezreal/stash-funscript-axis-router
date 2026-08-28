# XToys script

`funscriptAxisRouter.xtoys.json` is a starting-point XToys script that receives
the plugin's messages and drives up to **8 generic outputs**, each following a
funscript channel you name.

> **Untested.** Everything else in this repo has tests behind it; this file does
> not, because it runs on xtoys.app and there is no way to exercise it from here.
> It is built by reading a known-good XToys script export, so the shapes are
> right, but treat it as a draft to fix up in the XToys editor rather than
> something known to work. Please report what needed changing.

## Is this file importable?

**Probably not, and you should treat it as a blueprint rather than a file to
load.** The XToys guide documents loading scripts from *My Scripts* and *Public
Scripts*, and saving a public script to your own collection — but no JSON import
anywhere. The one public integration that ships an `xtoys_script.json`
(Bondage Club) does not tell people to import it either; it points them at a
published script URL and says *Load Script*. The JSON in that repo is a
reference copy.

So unless the editor has an undocumented import — worth a look, and do say if you
find one — the practical path is to build the script once in the XToys editor
using **[Building it by hand](#building-it-by-hand)** below, then publish it and
share the link. This JSON stays useful as the exact specification of what to
build, and as something to diff against later.

## Where messages come in

From the [Webhook tool docs](https://guide.xtoys.app/tools/webhook.html):

- A webhook accepts **GET**, **POST** or **WebSocket**. WebSocket is the one to
  use here, and the docs describe it as suited to continuous exchange.
- **Every message must have an `action` key.** This is not optional, which is why
  the plugin sends one and why leaving *XToys Action Name* blank is only valid
  for a custom toy, never for a webhook.
- The script receives the `action` value plus every other key/value pair, exposed
  to connected actions as `{trigger-<key>}` variables that are destroyed once
  those actions finish.
- A **private** webhook needs only its Webhook ID. A **shared** webhook also
  needs `Authorization: Bearer <token>`.

The auth token being a header is the awkward part, since a browser cannot set
headers on a WebSocket — the plugin sends it as `?token=` instead, which is what
`knock-rod` does successfully. A **private** webhook avoids the question
entirely, so prefer one.

No rate limits are documented. If axis updates arrive throttled, lower the
plugin's *Update Rate (Hz)* before assuming anything else is wrong.

## Setup## Setup## Setup

1. Import `funscriptAxisRouter.xtoys.json` into XToys.
2. Open the script's **Webhook** block and copy the webhook ID into the stash
   plugin's *XToys Webhook ID* setting.
3. Connect a device to each **Generic** output you want to use.
4. In the script config, type a funscript channel name into **Output N channel** —
   `roll`, `pitch`, `e-stim`, whatever your script actually contains. Leave a box
   empty to leave that output alone. Matching is case-insensitive.
5. Press play in stash. The browser console lists the channels being routed if
   you are unsure what a file contains.

## Config

| Control | Default | Meaning |
|---|---|---|
| Output 1–8 channel | empty | Funscript channel this output follows. Empty = unused. |
| Ramp (ms) | `100` | Smoothing between updates. Roughly one update interval is a good start. |
| Heartbeat timeout (ms) | `3000` | Outputs stop if no message arrives for this long. Keep it 2–3× the plugin's heartbeat interval. |

## What it reacts to

Three triggers, matching the `action` field the plugin sends:

- **`axes`** — parses the `payload` field and sets each mapped output.
- **`pause`** — `1` zeroes every output and holds them there, `0` releases.
- **`heartbeat`** — resets the watchdog.

The `Watchdog` job counts up every 500 ms and is reset by any incoming message.
If it passes the timeout, every output is driven to zero — that is what protects
you if the browser tab crashes or the network drops.

## Why `payload` rather than the flat keys

The plugin sends both. An XToys trigger binds incoming keys statically, as
`trigger-<key>`, which cannot express "read whatever channel the user typed into
a config box". So the plugin repeats the whole channel map as one JSON string
under `payload`, and the script parses that and indexes it by the configured
names. The flat keys are still there for custom toys and simpler scripts.

## Building it by hand

The generated JSON describes exactly this. Build it once in the editor:

**Blocks** — add a *Webhook* tool and connect it to the script. Add eight
*Generic (1 output)* toys, or however many you need.

**Controls** — eight textboxes `channel1` … `channel8` (labelled "Output N
channel"), plus `rampMs` (default `100`) and `watchdogMs` (default `3000`).

**Variables, at script start** — `out1` … `out8` to `0`, `halted` to `0`,
`lastBeat` to `0`, and start the `Watchdog` job.

**Trigger, action `axes`** — a Custom Code action with `{trigger-payload}` and
the eight channel variables bound, holding the `pick`/`setVariables` code from
the generated JSON. Follow it with eight *setVolume* actions, output N taking
`{outN}` with ramp `{rampMs}/1000`, each conditional on `{outN} >= 0 && {halted} == 0`.

**Trigger, action `pause`** — set `halted` to `{trigger-pause}`, and when it is
`1`, setVolume `0` on every output.

**Trigger, action `heartbeat`** — reset `lastBeat` to `0`.

**Job `Watchdog`** — a 0.5 s timer that adds 500 to `lastBeat`, and drives every
output to `0` once `{lastBeat} > {watchdogMs}`. Every trigger above also resets
`lastBeat`, so it only fires when messages genuinely stop.

**On script stop** — setVolume `0` on every output.

## Adapting it

The generated outputs are `generic-1-a` … `generic-1-h`. If you want a different
device type, change the `channels` entries and the `updateComponent` actions to
match — `setVolume`/`percentVolume` is the generic single-value interface.

`funscriptAxisRouter.xtoys.json` is generated by `build-xtoys-script.py`, so if
you change the number of outputs, edit `N` there and regenerate rather than
hand-editing the JSON.
