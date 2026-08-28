# XToys script

Two ways to build the XToys side. **Prefer the JavaScript one.**

| File | What it is |
|---|---|
| [`diagnostic.js`](diagnostic.js) | Paste in first. Reports what arrives and what your blocks are called. |
| [`funscriptAxisRouter.js`](funscriptAxisRouter.js) | Paste into the XToys **JS editor**. Recommended — nothing to import. |
| [`funscriptAxisRouter.xtoys.json`](funscriptAxisRouter.xtoys.json) | The same thing as blocks and triggers, for building in the editor by hand. |

Both drive up to **8 generic outputs**, each following a funscript channel you
name.

> **Untested.** Everything else in this repo has tests behind it; these do not,
> because they run on xtoys.app. The shapes come from real script exports and the
> official JS API docs, but treat them as drafts. Please report what needed
> changing.

## Set the channel names by hand

`WEBHOOK` and `TOYS` at the top of the script must match the `channels: {}`
section of your Script Export. They are deliberately **not** discovered:
`getConnectedBlocks()` has been seen returning an object keyed by channel name
in one script and a plain array in another, and calling `callAction()` with a
channel that does not exist crashes XToys internally with
`can't access property "isToy"`.

```js
var WEBHOOK = "webhook-a";
var TOYS = "generic-1-a,generic-1-b,generic-1-c";
```

The first toy in `TOYS` follows Control `out1`, the second `out2`, and so on. The
startup log prints the pairing, and any output that cannot be driven is reported
rather than taking the script down with it.

## Start here: the diagnostic

Before wiring outputs, paste [`diagnostic.js`](diagnostic.js) into the JS editor
and play a scene. It drives nothing and reports three things we otherwise have to
guess at:

- **what your blocks are called** — `getConnectedBlocks()` output, which gives you
  the real channel names for `OUTPUTS`
- **whether the triggers fire at all**
- **the exact `trigger-<key>` data** each message carries

Expect roughly:

```
connected blocks: [...]
diagnostic ready; listening on channel 'webhook-a'
status #1  {trigger-title = My Scene, trigger-position = 0, ...}
axes #1    {trigger-roll = 50, trigger-pitch = 35, trigger-payload = {...}, ...}
heartbeat #1  {...}
```

**Nothing at all** means `WEBHOOK` at the top does not match the channel name of
the block receiving the messages — the `connected blocks` line tells you what to
put there.

## The JavaScript route

XToys scripts can run custom JavaScript — the **JS** button in the toolbar while
editing a Script. That sidesteps importing entirely: paste
`funscriptAxisRouter.js`, edit the `OUTPUTS` list at the top, done.

It is also better suited to the job. `registerTrigger(json, fn)` hands the
callback *the whole message* as `trigger-<key>`, so a channel whose name you only
typed in at runtime can be read directly, with no static binding to work around.
The `payload` field the plugin sends exists only for the block-and-trigger route.

Constraints, from the [JS docs](https://guide.xtoys.app/script-creation/javascript.html):
**ES5 only**, run under JS-Interpreter, no DOM, slower than native actions. The
helpers available are `getVariable`, `setVariable`, `callAction`,
`registerTrigger`, `getXhr`, `getConnectedBlocks`, `sleep` and `console.log`.

There is no timer and `sleep()` would block the interpreter, so the watchdog has
to be a Job — see [Building it by hand](#building-it-by-hand).

## Importing the JSON

There does not appear to be a way. The guide documents loading scripts from *My
Scripts* and *Public Scripts* and saving a public script to your collection, but
no JSON import. The one public integration shipping an `xtoys_script.json`
(Bondage Club) points people at a published script URL instead; its JSON is a
reference copy. Ours is the same — a specification, not a file to load. Say so if
you find an import in the editor and this changes.

## Where messages come in

From the [Webhook tool docs](https://guide.xtoys.app/tools/webhook.html):

- A webhook accepts **GET**, **POST** or **WebSocket**. WebSocket is the one to
  use here, and the docs describe it as suited to continuous exchange.
- **Every message must have an `action` key.** Not optional — which is why the
  plugin sends one, and why leaving *Action Name* blank is valid only for a
  custom toy, never a webhook.
- The script gets the `action` value plus every other key/value pair, exposed to
  connected actions as `{trigger-<key>}` and destroyed once they finish.
- A **private** webhook needs only its Webhook ID. A **shared** webhook also
  needs `Authorization: Bearer <token>`.

The token being a header is awkward, since a browser cannot set headers on a
WebSocket — the plugin sends `?token=` instead, which is what `knock-rod` does
successfully. A **private** webhook avoids the question entirely, so prefer one.

No rate limits are documented. If updates arrive throttled, lower the plugin's
*Update Rate (Hz)* before assuming anything else is wrong.

### A custom toy will not work as the input

**Tested and ruled out.** With a `custom-websocket` toy connected, 40 trigger
shapes were registered against it — bare, `action=`, and `eventType=` — and not
one fired. A custom toy is something XToys *sends to*; it does not deliver
received messages to a script trigger.

It still appears in `channels` as `{"type": "generic-custom-toy"}` and can be an
**output**, driven with `action: "setValue"` and a `key` rather than the
`setVolume`/`percentVolume` generic toys use. Just not an input.

Use a **Private Webhook** instead:

1. [xtoys.app/me](https://xtoys.app/me) → Private Webhooks → create one → copy
   the Webhook ID.
2. In your script, use the plug button to add and connect a **Webhook** block.
   Tick **"Script can send outbound messages"** if you want the remote controls.
3. Put the Webhook ID into the plugin's *Webhook ID*, and leave
   *Auth Token* blank — private webhooks need no token.

### Older notes on custom toys

**Confirmed from a real export:** a custom toy appears in a script's `channels`
map as

```json
"generic-custom-toy-b": { "name": "stash", "type": "generic-custom-toy" }
```

so it can be a script channel. For the JSON route, uncomment the two lines near
the top of `build-xtoys-script.py` and match the letter suffix to your slot; for
the JS route, change `WEBHOOK` at the top of `funscriptAxisRouter.js`.

Custom toys are driven with `action: "setValue"` and a `key`, not the
`setVolume`/`percentVolume` that generic toys use — so pointing an *output* at
one changes the action shape too.

Still unverified is the direction that actually matters: whether a custom toy
receiving JSON fires a script trigger carrying `trigger-<key>` data the way a
Webhook block does. If it does not, the Webhook block is the only inbound route.

## Setup

1. Add a **Webhook** tool and connect it to the script. Add one **Generic** toy
   per output you want.
2. Copy the Webhook ID into the plugin's *Webhook ID* setting.
3. Paste `funscriptAxisRouter.js` into the JS editor and edit `OUTPUTS`, or build
   the blocks by hand as below.
4. Press play in stash. The browser console lists the channels being routed if
   you are unsure what a file contains.

## What it reacts to

Three triggers, matching the `action` the plugin sends:

- **`axes`** — sets each mapped output.
- **`pause`** — `1` zeroes every output and holds, `0` releases.
- **`heartbeat`** — liveness for the watchdog.

## Remote controlling the player

The websocket runs both ways, so an XToys script can double as a remote for the
stash player — useful when stash is on a phone or headset and someone else is
driving the session from XToys.

**Enable outbound first.** Tick **"Script can send outbound messages"** when
adding the Private Webhook block connection to the script. Outbound only works
over a websocket, not GET or POST. Then turn on *Allow Remote Control* in the
plugin — it is off by default, because it lets whoever holds the XToys session
start, stop and seek your player.

### Status the plugin publishes

Roughly once a second, as `action: "status"`. The script drops these into
variables, so any Control that displays a variable can show them:

| Variable | Example |
|---|---|
| `videoTitle` | `My Scene` |
| `videoPosition` / `videoDuration` | `73` / `1284` (seconds) |
| `videoElapsed` | `1:13 / 21:24` |
| `videoPercent` | `6` |
| `videoPlaying` | `1` / `0` |

### Buttons

Add **push** Controls named `btnPlay`, `btnPause`, `btnToggle`, `btnBack`,
`btnFwd`, and a **slider** named `seekPercent`. Each sets its variable, which is
what the script's `variableChange` triggers fire on.

Commands understood by the plugin: `play`, `pause`, `toggle`,
`seek` (with `position` in seconds *or* `percent`), and `skip` (with `seconds`,
negative to go back). Seeks are clamped to the video length.

> **The outbound Action shape is unverified.** The docs confirm outbound messages
> exist but never show the Action JSON for sending one. Everything routes through
> a single `sendToStash()` function — if the buttons do nothing, use
> **Add XToys Action** in the JS editor with the webhook block selected to get
> the real JSON and fix that one function.

## Building it by hand

The JSON describes exactly this.

**Blocks** — a *Webhook* tool, plus eight *Generic (1 output)* toys.

**Controls** — a Control's name *is* the variable it sets, so add inputs named
`channel1` … `channel8`, plus `rampMs` (`100`) and `watchdogMs` (`3000`).

**At script start** — `out1` … `out8` to `0`, `halted` to `0`, `lastBeat` to `0`,
and start the `Watchdog` job.

**Trigger, action `axes`** — a Custom Code action binding `{trigger-payload}` and
the eight channel variables, holding the `pick` / `setVariable` code from the
JSON. Then eight *setVolume* actions, output N taking `{outN}` with ramp
`{rampMs}/1000`, each conditional on `{outN} >= 0 && {halted} == 0`.

**Trigger, action `pause`** — set `halted` to `{trigger-pause}`; when it is `1`,
setVolume `0` on every output.

**Trigger, action `heartbeat`** — reset `lastBeat` to `0`.

**Job `Watchdog`** — a 0.5 s timer adding 500 to `lastBeat`, driving every output
to `0` once `{lastBeat} > {watchdogMs}`. Every trigger resets `lastBeat`, so it
fires only when messages genuinely stop.

**On script stop** — setVolume `0` on every output.

## The `payload` copy

**Off by default**, and you almost certainly want it that way — it repeats the
whole channel map as an escaped JSON string, doubling every frame at 10 Hz.

It exists only for the block-and-trigger route, where bindings are static
`trigger-<key>` and so cannot express "read whatever channel the user typed into
a config box"; a Custom Code action parses the copy and indexes it by name. The
JS route has no use for it — `registerTrigger` passes the whole map to the
callback already. Turn it on with *Include Payload Copy* if you need it.

## Adapting it

Outputs are `generic-1-a` … `generic-1-h`. For a different device type, change
the `channels` entries and the `updateComponent` actions to match;
`setVolume`/`percentVolume` is the generic single-value interface.

`funscriptAxisRouter.xtoys.json` is generated by `build-xtoys-script.py` — change
`N` there and regenerate rather than hand-editing the JSON.
