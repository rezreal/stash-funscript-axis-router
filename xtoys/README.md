# XToys script

**Load [`xtoys-script.json`](xtoys-script.json).** That is the only file you
need — the JavaScript is inlined in its `customFunctions`, so it is
self-contained.

| File | What it is |
|---|---|
| [`xtoys-script.json`](xtoys-script.json) | **The script.** Load this into XToys. |
| [`funscriptAxisRouter.js`](funscriptAxisRouter.js) | The same JavaScript, standalone, for reading and diffing. CI fails if the two drift apart. |
| [`diagnostic.js`](diagnostic.js) | A probe that drives nothing and reports what arrives. For when something is silent. |

On start the XToys console prints a build hash, so you can tell what is actually
loaded:

```
funscript axis router build a7f9ea4a, listening on 'webhook-a'
```

It is a hash of the script itself, not the plugin version - editing the XToys
side does not touch the plugin. After changing `funscriptAxisRouter.js`, run
`node xtoys/stamp.mjs` to restamp it and re-embed it in the JSON; CI fails if
the stamp and the content disagree.

> **Beta, and only partly verified.** The message path is confirmed working end
> to end. The remote buttons are not: the outbound Action shape comes from
> `Add XToys Action` but has never been seen to arrive.

## The display Controls are editable

XToys has no read-only Control type — the documented set is Text Input, sliders,
Dropdown, Button group, Toggle and Push button — so the reported fields (Scene,
Elapsed, Rate, State, Channels) are text inputs and you *can* type into them.
Nothing reads them back, and the script rewrites them on every status message,
so an edit is overwritten within about a second.

They are labelled *(reported)* to make the distinction visible, and the Watchdog
Job clears them when the stash side stops sending — otherwise a scene title
would sit there implying something is still playing.

## The JavaScript does have timers

**Measured with [`timer-test.js`](timer-test.js), against a real setup.** The
claim that it had none was asserted early and never tested; it is wrong.

```
setTimeout: function      setInterval: function     sleep: function
Date: function            performance: undefined    Promise: undefined
requestAnimationFrame: undefined
```

`setTimeout` fired. `setInterval` fired **142 times in 18.6 s** — and that is
the number that matters:

- It was asked for **100 ms**, so 10/s was the ceiling. It achieved **7.6/s**
  wall-clock, or **~8.5/s** discounting the 2 s spent inside a `sleep()`.
- With a callback that does nothing. A render callback interpolating eight
  channels and issuing a `callAction` each would be far heavier.

So the interpreter does not reliably hold even 10 Hz on an empty callback.
That rules out interpolating on the XToys side at any useful resolution — 10 Hz
is what the plugin already streams, so there is nothing to win. It does **not**
rule out scheduling: firing at each funscript point is a few Hz for typical
scripts, and a `setVolume` `rampTime` covering the gap to the next point renders
the segment at the toy's own rate rather than the interpreter's.

`Date.now()` advances, so a receiver can tell how late a message is — which is
what a scheduler would need to correct against.

### sleep() stops message delivery

`sleep(2000)` spanned messages 3 → 3: **none arrived during it.** Whether they
queue behind it or are dropped is not yet established — the probe now also
counts `setInterval` ticks across the sleep, which separates "only this function
blocked" from "the whole interpreter stalled". Until that is known, treat
`sleep()` as unusable for anything that must not miss a message.

### Consequences not yet acted on

The Watchdog Job could move into JavaScript now that `setInterval` exists. It
works as it is, so this is a note rather than a plan.

## The channel mapping survives a restart

`out1`..`out8` are listed in the manifest's `persistentVariables`, so XToys keeps
them after the Script is stopped and carries them across devices:

```json
"persistentVariables": ["out1", "out2", ..., "out8"]
```

Those eight are the only user-provided configuration here, which is why they are
the only ones on the list. Nothing else belongs on it:

- the reported fields (Scene, Elapsed, Rate, State, Channels) would come back
  showing a scene that is not playing — the exact thing the Watchdog clears
- `Speed` and `Seek` describe the track being played, not a preference, and both
  have a `variableChange` trigger that would send a command to stash on load
- `lastBeat` is the Watchdog's counter

`rampMs`, `skipSeconds` and `watchdogMs` could be added: `seed()` only writes
when a variable is empty, so a persisted value survives rather than being reset
to the default. They are left off because they are tuning, not configuration.

## Controls bind by `id`, not by name

A Control's **`id`** is the variable it reads and writes; **`name`** is only its
on-screen label:

```json
{ "id": "out1", "name": "Output 1 channel", "type": "input" }
```

A Control carrying only a `name` binds to an auto-generated id instead, so the
script writes `Scene` and nothing displays it, and reads `out1` and gets nothing
back. If you add Controls by hand, the id is the part that has to match.

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
  the real channel names for `TOYS`
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
`funscriptAxisRouter.js`, edit the `TOYS` list at the top, done.

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
  plugin always sends one and offers no way to turn it off. Omitting it would
  only ever have suited a custom toy, and a custom toy cannot be the input here
  anyway (below).
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
change `WEBHOOK` at the top of the script to its channel key.

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
3. Paste `funscriptAxisRouter.js` into the JS editor and edit `TOYS`, or build
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

`xtoys-script.json` embeds `funscriptAxisRouter.js`. Edit the JavaScript, then
re-embed it; `node test/check-xtoys.mjs` fails if the two fall out of step.
