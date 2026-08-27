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

1. In your XToys script, add a **Webhook** trigger block and copy its webhook ID.
2. Paste that ID into the plugin's *XToys Webhook ID* setting.
3. Have the block react to the parameters below.

The plugin connects to `wss://webhook.xtoys.app/<id>`. The ID is the only
credential — there is no separate secret. (The `Authorization: Bearer` token you
may have seen in XToys integrations belongs to the *opposite* direction, where
XToys drives a custom toy of yours. A browser cannot set that header, and we
don't need it.)

## Messages

One flat JSON object per update:

```json
{ "roll": 62, "pitch": 41, "action": "funscript", "at": 12480, "playing": true }
```

- `action` — matches your webhook block, configurable, defaults to `funscript`.
- `at` — script position in ms, offset applied.
- `playing` — `false` on the final message when playback stops.
- one key per routed axis, `0`–`100`.

**Axis keys are taken verbatim from the funscript.** A v2.0 file with
`channels: { roll: …, "e-stim": … }` sends `roll` and `e-stim`; a v1.1 file with
`axes: [{ id: "R1" }]` sends `R1`. Nothing is renamed, so arbitrary channel names
work — the name in the file is the contract with your XToys script.

`playing: false` deliberately carries the *last* values rather than zeros,
because zero is not a neutral for every axis (50 is centre for roll and pitch, 0
is off for a vibe). Your XToys script decides what to do on stop.

Channels named `action`, `at` or `playing` are skipped with a console warning —
they would collide with the message format.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Stroke Axis Owner | `auto` | `auto`, `router` or `handy` — see below. |
| XToys Webhook ID | — | Blank disables routing entirely. |
| XToys Action Name | `funscript` | The `action` field value. |
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
