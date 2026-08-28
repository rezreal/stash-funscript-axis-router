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
2. Copy its webhook ID into the *XToys Webhook ID* setting. If it also gives you
   a token, put that in *XToys Token*.
3. Have your script read the channel names your funscript uses.

### Messages

One newline-terminated JSON object per update, keyed by channel, values `0`–`100`
as strings:

```
{"roll":"62","pitch":"41"}\n
```

**Channel names are taken verbatim from the funscript.** A v2.0 file with
`channels: { roll: …, "e-stim": … }` sends `roll` and `e-stim`; a v1.1 file with
`axes: [{ id: "R1" }]` sends `R1`. Nothing is renamed, so arbitrary channel names
work — the name in the file is the contract with your XToys script.

Nothing else is in the payload: no action, timestamp or status fields, so a
channel can be called anything without colliding with the protocol.

### About the token

A **custom toy** gives you a token; pass it in *XToys Token* and it is sent as a
query parameter:

```
wss://webhook.xtoys.app/<webhookId>?token=<token>
```

XToys documents custom-toy auth as an `Authorization: Bearer` header, but a
browser cannot set headers on a WebSocket. The query parameter is what works
from one — as demonstrated by [knock-rod](https://github.com/rezreal/knock-rod),
which drives XToys from the browser this way.

A **webhook block inside a script** needs no token, so leaving the field blank is
equally valid.

On a good connection XToys replies `{"success": true}`. That is logged as
`XToys acknowledged the connection`. Sending is not gated on it, since a
tokenless webhook may never send one, but if you set a token and no
acknowledgement arrives within 5 seconds a warning appears in the console —
usually a wrong token.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Stroke Axis Owner | `auto` | `auto`, `router` or `handy` — see below. |
| XToys Webhook ID | — | Blank disables routing entirely. |
| XToys Token | — | Only for a custom toy; sent as `?token=`. See *About the token* above. |
| Stop Value | — | What to send every channel on stop. Blank holds the last values; `0` parks vibrations. |
| Axes To Route | all | e.g. `roll, pitch`. Matches the channel name as written, or its T-Code id — `roll` and `R1` both select the same axis. |
| Update Rate (Hz) | `10` | Keep at or below XToys' Max Message Frequency. |
| Deadband | `2` | Skip sending while nothing moved this far (0–100). |
| Axis Offset (ms) | interface offset | Falls back to Settings > Interface > Funscript Offset. |

## Who drives the stroke axis

The **Stroke Axis Owner** setting decides this, because the two candidates do not
share a clock.

| Value | Behaviour |
|---|---|
| `auto` *(default)* | The Handy plays it when a Handy key is configured; this plugin routes it otherwise. |
| `router` | This plugin always routes it, on the same clock as every other axis. The Handy is **not used at all**, even if configured. |
| `handy` | Always left to the Handy. If no key is configured, nothing plays it. |

`auto` is the best of both when you have a Handy: it plays the stroke axis off
its own uploaded script, synced against the Handy's *server* time, which is more
accurate than anything a browser can do. The catch is that every other axis is
ticked from the *browser* clock, so the two can drift apart over a long scene.

`router` trades that accuracy for phase coherence — one clock drives everything,
so the axes stay aligned with each other even though none of them get the Handy's
server sync. Choose it if you notice the stroke axis sliding out of phase with
the rest; it's the right setting for coordinated multi-axis hardware such as an
OSR2 or SR6 driven through XToys.

## Script formats

Axes are read from whichever container the file uses:

- **v2.0** — `channels: { roll: { actions: [...] }, ... }`
- **v1.1** — `axes: [ { id: "R1", actions: [...] }, ... ]`
- **v1.0** — top-level `actions` only, i.e. stroke alone.

A file carrying the same axis in both containers collapses to one. Per-axis
`inverted` and `range` are honoured, same as stash does for the Handy.

Sibling-file multi-axis (`video.roll.funscript`) is **not** supported: stash only
ever serves `<base>.funscript` from `/scene/:id/funscript`, so the axes have to
be embedded in the one file.

## Caveats

- **Clock drift.** With the default `auto` setting the Handy plays the stroke
  axis off *server* time while the other axes are ticked from the *browser*
  clock, so the two can drift apart. Set Stroke Axis Owner to `router` to put
  every axis on one clock — see above.
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

## Notes on stash internals

Three things this plugin works around, all in `ui/v2.5/src/hooks/Interactive/`:

- `handyKey` must be non-empty or `context.tsx`'s `uploadScript` and
  ScenePlayer's readiness check both bail. Without a Handy we return the plugin
  id as a sentinel.
- `sync()` must return non-zero. Its result becomes `serverOffset`, and
  `initialise()` won't call `connect()` while that is falsy — so the script would
  never load. We coerce `0` to `1`.
- The funscript offset never reaches the client: `context.tsx` passes it as
  `offset` while `interactive.ts` reads `config.scriptOffset`, and the client is
  constructed with `0`. We read `interface.funscriptOffset` from the config
  ourselves.

## License

[AGPL-3.0](LICENSE), matching [stash](https://github.com/stashapp/stash) itself.
