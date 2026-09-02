# Funscript Axis Router

> **Beta.** The logic is covered by tests, but it has not yet been exercised
> against real hardware — the XToys parameter names your script expects and the
> real-world latency at the default 10 Hz are the two things most likely to need
> adjusting. Expect to tweak settings, and please report what you find.

A **UI-only** [stash](https://github.com/stashapp/stash) plugin. No backend
process, no build step for the plugin itself — two files.

It replaces stash's interactive client with one that:

- delegates the **stroke axis** to the stock Handy client, untouched, and
- streams every **other axis** of a multi-axis funscript to an **XToys webhook**,
  under the names the script itself uses.

With no Handy configured it runs standalone and routes the stroke axis too.

## Install

**From the Plugin Manager** — Settings > Plugins > Available Plugins > Add
Source, pointing at this repo's published `index.yml`.

**Manually** — copy `plugin/funscriptAxisRouter.yml` and
`plugin/funscriptAxisRouter.js` into a `funscriptAxisRouter` folder in your stash
`plugins` directory, then Settings > Plugins > Reload Plugins.

Configure under **Settings > Plugins > Funscript Axis Router**.

## XToys setup

1. In XToys, create the thing that will receive the messages — either a
   **Webhook** trigger block inside a script, or a **custom toy**
   (`xtoys.app/me/custom-toys`).
2. Copy its webhook ID into the *Webhook ID* setting. If it also gives you
   a token, put that in *Auth Token*.
3. Have your script read the channel names your funscript uses.

### A ready-made script

[`xtoys/xtoys-script.json`](xtoys/) is a ready-made XToys script with **8
outputs**, each following a funscript channel you name in its config, plus
display fields and remote buttons. See [xtoys/README.md](xtoys/README.md). Load
that one file — the JavaScript is inlined in it.

### Messages

One newline-terminated JSON object per update:

```
{"roll":"50:0,100:340,0:500","pitch":"35:0,80:1500","action":"axes"}\n
```

Channels appear as flat keys. Each value is the **upcoming funscript points**
for that channel as `position:duration` pairs — *be at 50 now, reach 100 in
340 ms, then 0 in a further 500 ms*. Positions are `0`–`100`; durations are
milliseconds from the previous point, already divided by the playback rate, so
the XToys side does no arithmetic about tempo.

The XToys script schedules those and hands each to its toy as a ramp, so the toy
traverses the funscript's own segment at its own rate rather than following a
10 Hz staircase. Each frame **supersedes** the last, and every routed channel is
present in every frame — XToys merges trigger data, so a channel left out would
keep the previous schedule running. A channel past its last point sends `-`.

Frames go out a few times a second rather than at `Update Rate`: one is only
sent once the schedule already sent is half spent, or immediately on a seek,
pause or playback-rate change, since each of those invalidates every duration in
flight. See *Lookahead*.

**Latency and jitter.** A frame that continues the previous one does not reset
the XToys side's clock — it chains onto the schedule already running, so a late
message is absorbed rather than dragging everything after it. Only a
discontinuity re-anchors, which the plugin marks by leading the frame with a
duration of `0`. Raising *Lookahead* therefore helps twice: fewer frames, and
fewer chances to be knocked off. It does not help with steady latency, where the
toy simply trails the video — that is what *Offset* is for.

A very dense channel is capped at 24 points per frame, so a frame can cover less
than *Lookahead* asks. Top-ups are timed on what the frame actually reached, not
on the setting, or a fast script would run its schedule dry between frames.

Plus one envelope field: **`action`**, which selects the trigger inside an XToys
script. There are only two: `axes` for the schedules, and `status` for
everything else.

*Include Payload Copy* adds a `payload` field repeating the same map as one JSON
string. It is **off by default** — it doubles every frame, and only helps the
block-and-trigger route, where bindings are static and cannot read a channel
named at runtime. A script using `registerTrigger` receives the whole map in its
callback and has no use for it.

The XToys [webhook docs](https://guide.xtoys.app/tools/webhook.html) are explicit
that *"webhook messages must have an action key"*, so every message carries one:
`axes` for the schedules and `status` for the rest. It is not a setting —
the only reason to omit it was a custom toy, and a custom toy cannot receive
these messages at all (see [xtoys/README.md](xtoys/)). A channel named `action`
is skipped with a console warning, and `payload` likewise when the payload copy
is enabled.

**Channel names are taken verbatim from the funscript.** A v2.0 file with
`channels: { roll: …, "e-stim": … }` sends `roll` and `e-stim`; a v1.1 file with
`axes: [{ id: "R1" }]` sends `R1`. Nothing is renamed, so arbitrary channel names
work — the name in the file is the contract with your XToys script.

Nothing else is in the payload: no action, timestamp or status fields, so a
channel can be called anything without colliding with the protocol.

### About the token

A **custom toy** gives you a token; pass it in *Auth Token* and it is sent as a
query parameter:

```
wss://webhook.xtoys.app/<webhookId>?token=<token>
```

XToys documents custom-toy auth as an `Authorization: Bearer` header, but a
browser cannot set headers on a WebSocket. The query parameter is what works
from one — as demonstrated by [knock-rod](https://github.com/rezreal/knock-rod),
which drives XToys from the browser this way.

Per the docs, a **private** webhook needs only its ID, while a **shared** webhook
also wants the token. Prefer a private one and leave the field blank — it avoids
the header question altogether.

On a good connection XToys replies `{"success": true}`. That is logged as
`XToys acknowledged the connection`. Sending is not gated on it, since a
tokenless webhook may never send one, but if you set a token and no
acknowledgement arrives within 5 seconds a warning appears in the console —
usually a wrong token.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Route Stroke Axis Here | off | See *Who drives the stroke axis* below. |
| Webhook ID | — | From xtoys.app/me → Private Webhooks. Blank disables routing entirely. |
| Auth Token | — | Only for a **Shared** Webhook; sent as `?token=`. Blank for a Private one. |
| Include Payload Copy | off | Repeat the channels as a JSON string. Doubles frame size; only for the block route. |
| Allow Remote Control | off | Let XToys drive playback. See *Remote control* below. |
| Status Interval (ms) | `1000` | How often to publish title/position/duration. `0` disables. |
| Stop Value | — | What to send every channel on stop. Blank holds the last values; `0` parks vibrations. |
| Axes To Route | all | e.g. `roll, pitch`. Matches the channel name as written, or its T-Code id — `roll` and `R1` both select the same axis. |
| Update Rate (Hz) | `10` | Keep at or below XToys' Max Message Frequency. |
| Deadband | `2` | Per channel: a channel is only sent once it has moved this far since it was last sent (0–100). |
| Axis Offset (ms) | interface offset | Falls back to Settings > Interface > Funscript Offset. |

## Who drives the stroke axis

The **Route Stroke Axis Here** checkbox decides this, because the two candidates
do not share a clock.

| State | Behaviour |
|---|---|
| **off** *(default)* | The Handy plays it when a Handy key is configured. With no Handy, this plugin routes it, so it is never simply dropped. |
| **on** | This plugin always routes it, on the same clock as every other axis. The Handy is **not used at all**, even if configured. |

Off is the better default when you have a Handy: it plays the stroke axis from
its own uploaded script against the Handy's *server* time, which is more accurate
than anything a browser can manage. The catch is that every other axis is ticked
from the *browser* clock, so the two can drift apart over a long scene.

On trades that accuracy for phase coherence — one clock drives everything, so the
axes stay aligned with each other even though none of them get the Handy's server
sync. Tick it if you notice the stroke axis sliding out of phase with the rest;
it is the right setting for coordinated multi-axis hardware such as an OSR2 or
SR6 driven through XToys.

## What goes on the wire

Only the channels that moved. Each is compared against the value last *sent* for
it, not last sampled, so a slow drift still crosses the deadband eventually
instead of creeping out of sync. A tick where nothing moved sends nothing at all.

That works because XToys merges trigger data rather than replacing it: a channel
left out of a message keeps its previous value on that side. Partial frames would
be wrong on a protocol without that property.

Every channel is resent when playback is not continuous — the first frame, after
a seek in either direction, and at least once a second. After a seek the held
values describe a position the player has left, and a channel that happened to
land back on its previous value would otherwise never be corrected.

## Remote control

The websocket runs both ways. The plugin publishes what the player is doing —
title, position, duration, playing, rate — about once a second, and can accept
`play` / `pause` / `toggle` / `seek` / `skip` / `rate` back. An XToys script then works as
a remote for the stash player, which is the point when stash is on a phone or
headset and someone else is running the session.

*Allow Remote Control* is **off by default**: with it on, anyone with access to
the XToys session can start, stop and seek your player. It also needs
**"Script can send outbound messages"** ticked on the webhook connection in
XToys, and a websocket connection — outbound does not work over GET or POST.

Status publishing is independent and on by default; set *Status Interval* to `0`
to send nothing. It starts as soon as a scene loads, not when playback does, so
the remote has something to show straight away.

See [xtoys/README.md](xtoys/README.md) for the control names to add.

## Stopping safely

Two things happen when playback stops:

- **The status message says so.** It carries `playing`, and is published the
  moment you pause rather than only on its interval — which matters now that
  frames are buffered, or the XToys side would play on for up to a whole
  *Lookahead* after the video stopped. The transport is stated rather than read
  back off the player, since the player has not always updated by then.
- **Stop Value** — park every channel at a set value. Blank holds the last
  positions, because zero is not a neutral for every axis (50 is centre for roll
  and pitch, 0 is off for a vibrator). Either way the park frame is what
  supersedes whatever schedule was still buffered.

**There is no separate heartbeat or pause message.** Status is sent every
interval whether anything changed or not, so it is the deadman signal too:
closing the tab, a crash, or a dropped network all stop it, and the XToys side's
Watchdog zeroes its outputs. Make that watchdog two or three status intervals
long so one late message does not trip it. Setting *Status Interval* to `0`
turns the publisher off entirely — and with it the only liveness signal.

## Script formats

Axes are read from whichever container the file uses:

- **v2.0** — `channels: { roll: { actions: [...] }, ... }`
- **v1.1** — `axes: [ { id: "R1", actions: [...] }, ... ]`
- **v1.0** — top-level `actions` only, i.e. stroke alone. It is the one
  channel with no name in the file, so it goes out as `MAIN`; every other
  name is verbatim. A file whose own free-form channel is called `MAIN`
  collapses into it.

A file carrying the same axis in both containers collapses to one. Per-axis
`inverted` and `range` are honoured, same as stash does for the Handy.

Sibling-file multi-axis (`video.roll.funscript`) is **not** supported: stash only
ever serves `<base>.funscript` from `/scene/:id/funscript`, so the axes have to
be embedded in the one file.

## Caveats

- **Clock drift.** With the default `auto` setting the Handy plays the stroke
  axis off *server* time while the other axes are ticked from the *browser*
  clock, so the two can drift apart. Tick Route Stroke Axis Here to put every
  axis on one clock — see above.
- **Latency.** XToys webhooks are a cloud round-trip. Good enough for auxiliary
  motion, not good enough to have been worth using for the stroke axis.
- **On stop**, values are held rather than zeroed by default, because zero is not
  a neutral for every axis — 50 is centre for roll and pitch, 0 is off for a
  vibe. Set *Stop Value* to `0` if any channel drives a vibrator.
- Scenes need a `.funscript` next to the video (stash's `interactive` flag), or
  the player never engages the interactive client at all.

## Development

```bash
node test/test.mjs   # runs the plugin against a stubbed browser, no deps
./build.sh           # produces dist/index.yml + dist/funscriptAxisRouter.zip
```

`build.sh` emits a stash *package source*: a flat zip plus the `index.yml` that
advertises it. The zip must stay flat — stash writes each entry verbatim under
`plugins/<id>/`, so a wrapping directory would nest.

### Publishing

The GitHub Actions workflow tests and builds on every push. The publish step is
skipped while the repo is private — GitHub Pages needs a public repo (or a paid
plan), and publishing should be deliberate anyway. To go live: make the repo
public, enable Pages under Settings > Pages with **Source: GitHub Actions**, and
push. `https://<user>.github.io/<repo>/index.yml` is then the source URL users
add under Settings > Plugins > Available Plugins > Add Source.

## Troubleshooting

Open the browser console. The plugin logs on load, and each stage after it:

```
[funscript-axis-router] installed; ...
[funscript-axis-router] XToys socket open
[funscript-axis-router] XToys acknowledged the connection   (only with a token)
[funscript-axis-router] interactive client ready
[funscript-axis-router] loading http://.../scene/42/funscript
[funscript-axis-router] routing 3 axis/axes: roll, pitch, MAIN
[funscript-axis-router] first status frame: {"title":"My Scene",...,"action":"status"}
[funscript-axis-router] first axes frame: {"roll":"50:0,100:500",...,"action":"axes"}
```

The `first … frame` lines print once per message kind — axis updates run at 10 Hz,
so logging every one would be useless, but seeing one of each is what you need to
line the keys up with an XToys script. Inbound remote-control commands are logged
as `from XToys: …`.

**"XToys acknowledged the connection" but nothing in the Network tab.** The
connection is fine — that line is only logged when XToys sends `{"success":true}`
*back*, which cannot happen without an established socket. DevTools only records
requests made while it is open, and the plugin connects during page load: open
DevTools first, hard-reload, then filter by **WS**. The entry's *Messages* tab
shows frames live.

**No "XToys socket open" at all.** The socket is opened as soon as the plugin
loads, so this means the plugin did not load or has no webhook ID. Check it
appears in Settings > Plugins, that *Webhook ID* is set, and that
Settings > Interface does not have customizations disabled.

**Socket opens, then closes repeatedly.** Wrong webhook ID, or a shared webhook
whose token is not being accepted. Prefer a private webhook.

**Socket open but no "loading …".** stash never called the plugin, so nothing is
routed. The scene needs a `.funscript` beside the video, or `scene.interactive`
is false and the player never engages the interactive client at all.

**"loading" but "routing 0 axis/axes".** The file has no auxiliary axes — a v1.0
funscript is stroke only. With a Handy configured the stroke axis is withheld
too; tick *Route Stroke Axis Here* if you want it.

## Notes on stash internals

Three things this plugin works around, all in `ui/v2.5/src/hooks/Interactive/`:

- `handyKey` must be non-empty or `context.tsx`'s `uploadScript` and
  ScenePlayer's readiness check both bail. Without a Handy we return the plugin
  id as a sentinel.
- `handyKey` must *change* during `configure()`, not merely be non-empty.
  `context.tsx` calls `initialise()` only when the key differs from what it was
  before the call, so a constant sentinel means nothing ever initialises and no
  script is ever uploaded. It also has to change twice: `initialise()` reads
  `serverOffset` from a stale closure, so the first call only syncs and the
  second is the one that reaches `connect()`. We vary the sentinel until
  `connect()` lands, then let it settle.
- `sync()` must return non-zero. Its result becomes `serverOffset`, and
  `initialise()` won't call `connect()` while that is falsy — so the script would
  never load. We coerce `0` to `1`.
- The funscript offset never reaches the client: `context.tsx` passes it as
  `offset` while `interactive.ts` reads `config.scriptOffset`, and the client is
  constructed with `0`. We read `interface.funscriptOffset` from the config
  ourselves.

## License

[AGPL-3.0](LICENSE), matching [stash](https://github.com/stashapp/stash) itself.
