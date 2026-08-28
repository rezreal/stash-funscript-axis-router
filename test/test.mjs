import fs from "node:fs";
import vm from "node:vm";

const SRC = fs.readFileSync("plugin/funscriptAxisRouter.js", "utf8");

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log("  ok   " + name); }
  else { fails++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), {got: a, want: b}); }

// ---- harness -------------------------------------------------------------
function makeEnv(funscript, pluginSettings, ifaceSettings, handy) {
  const sent = [];
  const calls = [];
  const player = {
    t: 0, isPaused: false, dur: 200,
    currentTime(v) { if (v !== undefined) { this.t = v; calls.push("seek:" + v); } return this.t; },
    paused() { return this.isPaused; },
    duration() { return this.dur; },
    play() { this.isPaused = false; calls.push("play"); },
    pause() { this.isPaused = true; calls.push("pause"); },
  };
  let tickFn = null, hbSlot = null, stSlot = null, tickMs = null;

  const raw = [], conns = [];
  class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 1;
      FakeWS.last = this; conns.push({ url, protocols });
      setTimeout(() => { if (FakeWS.rejectAll) { this.readyState = 3; this.onclose && this.onclose(); } else { this.onopen && this.onopen(); } }, 0);
    }
    send(s) { raw.push(s); sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
  }

  const InteractiveUtils = { getPlayer: () => player, interactiveClientProvider: undefined };
  const ctx = {
    console, Promise, JSON, Math, Date, Object, Array, isFinite, parseFloat, URL, Error,
    WebSocket: FakeWS,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => {
      if (ms === 1000) { if (hbSlot === null) { hbSlot = fn; return 2; } stSlot = fn; return 3; }
      if (ms >= 200 && ms !== tickMs && hbSlot === null) { hbSlot = fn; return 2; }
      tickFn = fn; tickMs = ms; return 1;
    },
    clearInterval: (id) => { if (id === 2) hbSlot = null; else if (id === 3) stSlot = null; else tickFn = null; },
    fetch: async () => ({ ok: true, json: async () => funscript }),
    window: {
      PluginApi: {
        utils: {
          InteractiveUtils,
          StashService: { getClient: () => ({ query: async () => ({ data: { findScene: { title: "My Scene" } } }) }) },
        },
        GQL: { FindSceneDocument: {} },
      },
      location: { href: "http://localhost:9999/scenes/1" },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const handyBuilt = { n: 0 };
  const iface = Object.assign({}, ifaceSettings || {});
  if (handy) iface.handyKey = "REALKEY";
  const opts = {
    handyKey: "", scriptOffset: 0,
    defaultClientProvider: handy ? (() => { handyBuilt.n++; return handy; }) : undefined,
    stashConfig: { interface: iface, plugins: { funscriptAxisRouter: pluginSettings || {} } },
  };
  const client = InteractiveUtils.interactiveClientProvider(opts);
  return { client, sent, raw, conns, FakeWS, player, calls, handyBuilt, sock: () => FakeWS.last, beat: () => hbSlot && hbSlot(), hasBeat: () => !!hbSlot, tick: () => tickFn && tickFn(), hasTick: () => !!tickFn };
}

const V2 = {
  version: "2.0",
  actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }],
  channels: {
    roll:  { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }, { at: 2000, pos: 0 }] },
    pitch: { actions: [{ at: 0, pos: 20 }, { at: 2000, pos: 80 }] },
  },
};
const V11 = {
  version: "1.1",
  actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }],
  axes: [
    { id: "R1", actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    { id: "L1", actions: [{ at: 0, pos: 50 }, { at: 1000, pos: 50 }] },
  ],
};
const V10 = { version: "1.0", actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] };

// ---- 1. v2.0 channels ----------------------------------------------------
console.log("\nv2.0 channels");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("http://localhost:9999/scene/1/funscript");
  await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("interval started", e.hasTick());
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("channel names verbatim (+stroke, no Handy here)", Object.keys(m).sort(), ["pitch","roll","stroke"]);
  eq("roll interpolated at 500ms", m.roll, "50");
  eq("pitch interpolated at 500ms", m.pitch, "35");
}

// ---- 2. v1.1 axes --------------------------------------------------------
console.log("\nv1.1 axes array");
{
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.25; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("v1.1 ids sent verbatim", Object.keys(m).sort(), ["L1","R1","stroke"]);
  eq("R1 at 250ms", m.R1, "25");
}

// ---- 3. v1.0 has no aux --------------------------------------------------
console.log("\nv1.0 single axis");
{
  const handy = { handyKey: "REALKEY", connected: true, playing: false,
    connect: () => Promise.resolve(), sync: () => Promise.resolve(0), configure: () => Promise.resolve(),
    uploadScript: () => Promise.resolve(), play: () => Promise.resolve(), pause: () => Promise.resolve(),
    ensurePlaying: () => Promise.resolve(), setLooping: () => Promise.resolve() };
  const e = makeEnv(V10, { xtoysWebhookId: "abc", pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 }, {}, handy);
  await e.client.uploadScript("u"); await e.client.play(0);
  ok("with a Handy, stroke-only script routes nothing", !e.hasTick());
  eq("nothing sent", e.sent.length, 0);

  const e2 = makeEnv(V10, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e2.client.uploadScript("u"); await e2.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("without a Handy, stroke IS routed", e2.hasTick());
  e2.player.t = 0.5; e2.tick();
  eq("stroke value sent", e2.sent[e2.sent.length-1].stroke, "50");
}

// ---- 4. seeking ----------------------------------------------------------
console.log("\nseek");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 1.5; e.tick();
  eq("forward jump", e.sent[e.sent.length-1].roll, "50");
  e.player.t = 0.25; e.tick();
  eq("backward seek", e.sent[e.sent.length-1].roll, "25");
  e.player.t = 1.75; e.tick();
  eq("forward again", e.sent[e.sent.length-1].roll, "25");
}

// ---- 5. deadband ---------------------------------------------------------
console.log("\ndeadband");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 10, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const n = e.sent.length;
  e.player.t = 0.51; e.tick();
  eq("tiny move suppressed", e.sent.length, n);
  e.player.t = 0.8; e.tick();
  eq("big move sent", e.sent.length, n + 1);
}

// ---- 6. pause ------------------------------------------------------------
console.log("\npause");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  await e.client.pause();
  ok("ticker cleared", !e.hasTick());
  ok("a final frame was sent on stop", e.sent.length > 0);
  e.player.isPaused = true;
}

// ---- 7. no-handy fallbacks ----------------------------------------------
console.log("\nno-handy operation");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 }, {});
  eq("handyKey starts empty, like the real client", e.client.handyKey, "");
  await e.client.configure({ connectionKey: "" });
  ok("configure makes it non-empty", e.client.handyKey.indexOf("funscriptAxisRouter") === 0, e.client.handyKey);
  eq("sync never returns 0", await e.client.sync(), 1);
  await e.client.connect();
  eq("connected after connect", e.client.connected, true);
}

// ---- 8. handy delegation -------------------------------------------------
console.log("\nhandy delegation");
{
  const calls = [];
  const fakeHandy = {
    handyKey: "REALKEY", connected: true, playing: false,
    connect: () => { calls.push("connect"); return Promise.resolve(); },
    sync: () => { calls.push("sync"); return Promise.resolve(0); },
    configure: () => Promise.resolve(),
    uploadScript: (u) => { calls.push("uploadScript:" + u); return Promise.resolve(); },
    play: () => { calls.push("play"); return Promise.resolve(); },
    pause: () => { calls.push("pause"); return Promise.resolve(); },
    ensurePlaying: () => Promise.resolve(),
    setLooping: () => Promise.resolve(),
  };
  const InteractiveUtils = { getPlayer: () => null, interactiveClientProvider: undefined };
  const ctx = { console, Promise, JSON, Math, Date, Object, Array, isFinite, parseFloat, URL, Error,
    WebSocket: class { constructor(){ this.readyState=1; } send(){} },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => V2 }),
    window: { PluginApi: { utils: { InteractiveUtils } }, location: { href: "http://x/" } } };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const c = InteractiveUtils.interactiveClientProvider({
    handyKey: "", scriptOffset: 0,
    defaultClientProvider: () => fakeHandy,
    stashConfig: { interface: { handyKey: "REALKEY" }, plugins: { funscriptAxisRouter: { xtoysWebhookId: "z" } } },
  });
  eq("handyKey proxied", c.handyKey, "REALKEY");
  eq("sync coerces 0 -> 1", await c.sync(), 1);
  await c.uploadScript("http://x/scene/1/funscript");
  ok("handy still got the script", calls.some(s => s.startsWith("uploadScript:")), calls);
  await c.play(0); await c.pause();
  ok("play/pause delegated", calls.includes("play") && calls.includes("pause"), calls);
}

// ---- 9. inverted / range -------------------------------------------------
console.log("\ninverted + range normalisation");
{
  const fs2 = { version: "2.0", channels: {
    roll: { inverted: true, actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    pitch: { range: 50, actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 50 }] } } };
  const e = makeEnv(fs2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 1.0; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("inverted flips 100 -> 0", m.roll, "0");
  eq("range 50 scales 50 -> 100", m.pitch, "100");
}

// ---- 10. offset + axis filter -------------------------------------------
console.log("\noffset + axis filter");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "roll", offsetMs: 500, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.0; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("filtered to roll only", Object.keys(m).sort(), ["roll"]);
  eq("offset applied (t=0 +500ms)", m.roll, "50");
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 }, { funscriptOffset: 1000 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.0; e.tick();
  eq("falls back to interface.funscriptOffset", e.sent[e.sent.length-1].roll, "100");
}


// ---- 11. arbitrary channel names ----------------------------------------
console.log("\narbitrary channel names");
{
  const custom = { version: "2.0", actions: [{at:0,pos:0},{at:1000,pos:100}], channels: {
    vibe:        { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    "e-stim":    { actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }] },
    R1:          { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 40 }] } } };
  const e = makeEnv(custom, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("unknown names pass through verbatim", Object.keys(m).sort(), ["R1","e-stim","stroke","vibe"]);
  eq("vibe value", m.vibe, "50");
  eq("e-stim value", m["e-stim"], "50");
  eq("R1 kept as R1, not renamed to roll", m.R1, "20");
}

// ---- 13. filter accepts either spelling ----------------------------------
console.log("\nfilter by name or id");
{
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0, axes: "roll" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  eq("'roll' selects the R1 channel", Object.keys(e.sent[e.sent.length-1]).sort(), ["R1"]);

  const e2 = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "R2" , xtoysAction: "", statusMs: 0 });
  await e2.client.uploadScript("u"); await e2.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e2.player.t = 0.5; e2.tick();
  eq("'R2' selects the pitch channel", Object.keys(e2.sent[e2.sent.length-1]).sort(), ["pitch"]);
}

// ---- 14. dedupe across containers ---------------------------------------
console.log("\ndedupe axes vs channels");
{
  const dup = { version: "2.0",
    axes: [{ id: "R1", actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] }],
    channels: { roll: { actions: [{ at: 0, pos: 100 }, { at: 1000, pos: 0 }] } } };
  const e = makeEnv(dup, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("R1 and roll collapse to one axis", Object.keys(m).sort(), ["R1"]);
}


// ---- 16. stroke axis ownership ------------------------------------------
console.log("\nstroke axis owner (checkbox)");
{
  const base = { xtoysWebhookId: "a", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 };
  const mkHandy = () => ({ handyKey: "REALKEY", connected: true, playing: false,
    connect: () => Promise.resolve(), sync: () => Promise.resolve(0), configure: () => Promise.resolve(),
    uploadScript: () => Promise.resolve(), play: () => Promise.resolve(), pause: () => Promise.resolve(),
    ensurePlaying: () => Promise.resolve(), setLooping: () => Promise.resolve() });

  async function run(settings, handy) {
    const e = makeEnv(V2, Object.assign({}, base, settings), {}, handy);
    await e.client.uploadScript("u"); await e.client.play(0);
    await new Promise(r => setTimeout(r, 5));
    e.player.t = 0.5; e.tick();
    return e;
  }

  // on: must decline the Handy outright, not merely ignore its output
  const on = await run({ routeStrokeAxis: true }, mkHandy());
  eq("on: Handy never constructed", on.handyBuilt.n, 0);
  eq("on: stroke routed alongside the rest", Object.keys(on.sent[on.sent.length-1]).sort(),
     ["pitch","roll","stroke"]);
  await on.client.configure({ connectionKey: "" });
  ok("on: sentinel key so the pipeline runs", on.client.handyKey.indexOf("funscriptAxisRouter") === 0, on.client.handyKey);

  // off + Handy: delegated, stroke withheld
  const off = await run({ routeStrokeAxis: false }, mkHandy());
  eq("off: Handy constructed", off.handyBuilt.n, 1);
  eq("off: stroke withheld", Object.keys(off.sent[off.sent.length-1]).sort(), ["pitch","roll"]);

  // off + no Handy: stroke still routed, so it is never silently dropped
  const solo = await run({ routeStrokeAxis: false });
  eq("off + no Handy: stroke routed", Object.keys(solo.sent[solo.sent.length-1]).sort(),
     ["pitch","roll","stroke"]);

  // unset behaves as off
  const dflt = await run({}, mkHandy());
  eq("unset defaults to off", Object.keys(dflt.sent[dflt.sent.length-1]).sort(), ["pitch","roll"]);

  // stash may hand booleans through as strings
  const str = await run({ routeStrokeAxis: "true" }, mkHandy());
  eq('string "true" is honoured', str.handyBuilt.n, 0);
}

// ---- 17. wire format ----------------------------------------------------
console.log("\nwire format");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const frame = e.raw[e.raw.length - 1];
  ok("frame is newline terminated", frame.endsWith("\n"), JSON.stringify(frame));
  ok("exactly one trailing newline", !frame.slice(0, -1).includes("\n"));
  eq("values are strings", typeof JSON.parse(frame).roll, "string");
  eq("no protocol keys leak in", Object.keys(JSON.parse(frame)).sort(), ["pitch","roll","stroke"]);
  eq("no subprotocol when no token", e.conns[0].protocols, undefined);
  eq("url has no query when no token", e.conns[0].url, "wss://webhook.xtoys.app/abc");
}

// ---- 18. stop value ------------------------------------------------------
console.log("\nstop value");
{
  const hold = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await hold.client.uploadScript("u"); await hold.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  hold.player.t = 0.5; hold.tick();
  const before = hold.sent[hold.sent.length - 1];
  await hold.client.pause();
  eq("blank holds the last values", hold.sent[hold.sent.length - 1], before);

  const park = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, stopValue: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await park.client.uploadScript("u"); await park.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  park.player.t = 0.5; park.tick();
  await park.client.pause();
  const m = park.sent[park.sent.length - 1];
  eq("stopValue 0 parks every channel", Object.keys(m).sort().map(k => k + "=" + m[k]),
     ["pitch=0","roll=0","stroke=0"]);
}

// ---- 19. token auth ------------------------------------------------------
console.log("\ntoken auth");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysToken: "TOK", pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  eq("token goes in the query string", e.conns[0].url, "wss://webhook.xtoys.app/abc?token=TOK");
  eq("no subprotocol is used", e.conns[0].protocols, undefined);
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysToken: "a b/c&d", pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  eq("token is url-encoded", e.conns[0].url, "wss://webhook.xtoys.app/abc?token=a%20b%2Fc%26d");
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  eq("no token means no query string", e.conns[0].url, "wss://webhook.xtoys.app/abc");
}

// ---- 20. server acknowledgement -----------------------------------------
console.log("\nserver ack");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysToken: "TOK", pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  const ws = e.FakeWS.last;
  ok("socket exposes onmessage", typeof ws.onmessage === "function");
  ws.onmessage({ data: JSON.stringify({ success: true }) });
  ok("ack handled without throwing", true);
  ws.onmessage({ data: "not json at all" });
  ok("malformed server data is ignored", true);

  // sending must not be gated on the ack - a tokenless webhook never sends one
  const n = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await n.client.uploadScript("u"); await n.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  n.player.t = 0.5; n.tick();
  ok("frames flow without any ack", n.sent.length > 0);
}


// ---- 21. pause event -----------------------------------------------------
console.log("\npause event");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u");
  await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  eq("resume event on start", e.sent[0], { pause: "0" });
  e.player.t = 0.5; e.tick();
  await e.client.pause();
  eq("pause event on stop", e.sent[e.sent.length - 1], { pause: "1" });
  eq("it is its own message, not mixed into values", Object.keys(e.sent[e.sent.length - 1]), ["pause"]);
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "halt", heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  await e.client.pause();
  eq("key is configurable", e.sent[e.sent.length - 1], { halt: "1" });
}
{
  // pause event + stop value compose: park the channels, then signal the halt
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, stopValue: 0, heartbeatKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  await e.client.pause();
  const last2 = e.sent.slice(-2);
  eq("channels parked first", Object.keys(last2[0]).sort(), ["pitch","roll","stroke"]);
  eq("then the pause event", last2[1], { pause: "1" });
}

// ---- 22. heartbeat -------------------------------------------------------
console.log("\nheartbeat");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("heartbeat timer started", e.hasBeat());
  const n = e.sent.length;
  e.beat();
  eq("heartbeat message", e.sent[e.sent.length - 1], { heartbeat: "1" });
  ok("heartbeat is a separate frame", e.sent.length === n + 1);

  // the whole point: still beating while paused, so "paused" != "browser gone"
  await e.client.pause();
  ok("heartbeat survives pause", e.hasBeat());
  e.beat();
  eq("still beating while paused", e.sent[e.sent.length - 1], { heartbeat: "1" });
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, heartbeatKey: "", pauseKey: "" , xtoysAction: "", statusMs: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("blank key disables the heartbeat", !e.hasBeat());
}


// ---- 23. script envelope -------------------------------------------------
console.log("\nscript envelope");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("default action name", m.action, "axes");
  ok("no payload copy by default", m.payload === undefined, Object.keys(m));
  eq("flat channel keys still present", [m.roll, m.pitch, m.stroke], ["50","35","50"]);
  eq("frame is channels plus action only", Object.keys(m).sort(), ["action","pitch","roll","stroke"]);
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysAction: "custom", pauseKey: "", heartbeatKey: "" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  eq("action name is configurable", e.sent[e.sent.length - 1].action, "custom");
}
{
  // pause and heartbeat get their own action names so a script can trigger on them
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  const resume = e.sent.filter(m => m.action === "pause")[0];
  eq("resume uses the pause action", resume.action, "pause");
  eq("resume carries the pause key", resume.pause, "0");
  e.beat();
  eq("heartbeat uses its own action", e.sent[e.sent.length - 1].action, "heartbeat");
  await e.client.pause();
  eq("pause uses the pause action", e.sent[e.sent.length - 1].action, "pause");
}
{
  // a channel colliding with the envelope must be dropped, not corrupt the message
  const clash = { version: "2.0", channels: {
    action:  { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    payload: { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    roll:    { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] } } };
  const e = makeEnv(clash, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "", includePayload: true });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("colliding channels skipped", JSON.parse(m.payload), { roll: "50" });
  ok("only the collisions were dropped", m.roll === "50");
  eq("action survives intact", m.action, "axes");
}
{
  // blank action = bare format, for a custom toy
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysAction: "", pauseKey: "", heartbeatKey: "" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  eq("no envelope when blank", Object.keys(e.sent[e.sent.length - 1]).sort(), ["pitch","roll","stroke"]);
}


// ---- 24. player status ---------------------------------------------------
console.log("\nplayer status");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  e.player.t = 12; e.player.dur = 200; e.player.isPaused = true;
  await e.client.uploadScript("http://x/scene/42/funscript");
  await new Promise(r => setTimeout(r, 20));
  const st = e.sent.filter(m => m.action === "status").pop();
  ok("status published without waiting for playback", !!st);
  eq("scene id parsed from the funscript url", st.scene, "42");
  eq("position", st.position, "12");
  eq("duration", st.duration, "200");
  eq("paused reported", st.playing, "0");
  eq("title resolved over graphql", st.title, "My Scene");
  eq("routed channels listed, in file order", st.channels, "stroke,roll,pitch");
}

// ---- 25. remote control --------------------------------------------------
console.log("\nremote control");
{
  const off = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  await off.client.uploadScript("http://x/scene/42/funscript");
  await new Promise(r => setTimeout(r, 5));
  off.sock().onmessage({ data: JSON.stringify({ action: "play" }) });
  off.sock().onmessage({ data: JSON.stringify({ action: "seek", position: 99 }) });
  eq("commands ignored while remote control is off", off.calls, []);

  const on = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "", remoteControl: true });
  on.player.t = 10; on.player.dur = 200; on.player.isPaused = true;
  await on.client.uploadScript("http://x/scene/42/funscript");
  await new Promise(r => setTimeout(r, 5));
  const sock = on.sock();

  sock.onmessage({ data: JSON.stringify({ action: "play" }) });
  ok("play", on.calls.includes("play"), on.calls);
  sock.onmessage({ data: JSON.stringify({ action: "pause" }) });
  ok("pause", on.calls.includes("pause"), on.calls);
  sock.onmessage({ data: JSON.stringify({ action: "toggle" }) });
  ok("toggle resumes from paused", on.calls.filter(c => c === "play").length === 2, on.calls);

  on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "seek", position: 50 }) });
  eq("seek to a position", on.calls, ["seek:50"]);

  on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "seek", percent: 25 }) });
  eq("seek by percent of duration", on.calls, ["seek:50"]);

  on.player.t = 100; on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "skip", seconds: -10 }) });
  eq("skip backwards", on.calls, ["seek:90"]);

  on.player.t = 195; on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "skip", seconds: 60 }) });
  eq("skip clamps to duration", on.calls, ["seek:200"]);

  on.player.t = 5; on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "skip", seconds: -60 }) });
  eq("skip clamps at zero", on.calls, ["seek:0"]);

  // the envelope XToys actually sends: action in webhookAction, extras in
  // webhookData as a raw k=v string
  on.player.t = 100; on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ webhookAction: "skip", format: "raw", webhookData: "seconds=-10" }) });
  eq("webhookAction + raw webhookData", on.calls, ["seek:90"]);

  on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ webhookAction: "play" }) });
  ok("webhookAction with no data", on.calls.includes("play"), on.calls);

  on.player.t = 10; on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ webhookAction: "seek", webhookData: '{"percent":25}' }) });
  eq("webhookData as JSON is accepted too", on.calls, ["seek:50"]);

  on.calls.length = 0;
  sock.onmessage({ data: JSON.stringify({ action: "axes", roll: "10" }) });
  sock.onmessage({ data: "garbage" });
  eq("unknown and malformed commands are inert", on.calls, []);
}


// ---- 26. stash initialisation handshake ---------------------------------
// Replays what context.tsx actually does. Without this the plugin looked fine
// in every other test and still never opened a socket in the real app.
console.log("\nstash initialisation handshake");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  const c = e.client;

  // context.tsx: const oldKey = interactive.handyKey; await configure(...);
  //              if (oldKey !== interactive.handyKey && interactive.handyKey) initialise();
  async function configurePass() {
    const oldKey = c.handyKey;
    await c.configure({ connectionKey: "", offset: 0 });
    return oldKey !== c.handyKey && !!c.handyKey;
  }

  ok("first configure triggers initialise", await configurePass());

  // initialise() run 1: serverOffset is 0, so it syncs and returns without connecting
  const offset = await c.sync();
  ok("sync returns a truthy offset", !!offset, offset);

  // config changed -> the effect runs again
  ok("second configure triggers initialise again", await configurePass());

  // initialise() run 2: serverOffset is set now, so this one connects
  await c.connect();
  eq("client reports connected", c.connected, true);

  // and once connected the key settles, so it stops re-initialising forever
  const settled = c.handyKey;
  await c.configure({ connectionKey: "", offset: 0 });
  eq("key stops changing once connected", c.handyKey, settled);
  ok("settled key is still non-empty", !!c.handyKey);
}
{
  // the socket must exist before any scene is loaded
  const e = makeEnv(V2, { xtoysWebhookId: "abc" });
  await new Promise(r => setTimeout(r, 5));
  ok("socket opens as soon as the plugin loads", e.conns.length > 0, e.conns);
  eq("connects to the configured webhook", e.conns[0].url, "wss://webhook.xtoys.app/abc");
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "" });
  await new Promise(r => setTimeout(r, 5));
  eq("no webhook id means no socket", e.conns.length, 0);
}


// ---- 27. payload copy is opt-in -----------------------------------------
console.log("\npayload copy");
{
  const off = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  await off.client.uploadScript("u"); await off.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  off.player.t = 0.5; off.tick();
  const a = off.sent.filter(m => m.action === "axes").pop();
  ok("absent by default", a.payload === undefined, Object.keys(a));

  const on = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "", includePayload: true });
  await on.client.uploadScript("u"); await on.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  on.player.t = 0.5; on.tick();
  const b = on.sent.filter(m => m.action === "axes").pop();
  const inner = JSON.parse(b.payload);
  eq("present when asked for", Object.keys(inner).sort(), ["pitch","roll","stroke"]);
  ok("not nested inside itself", !("payload" in inner) && !("action" in inner));

  // a channel really called "payload" is fine while the copy is off
  const clash = { version: "2.0", channels: {
    payload: { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    roll:    { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] } } };
  const c = makeEnv(clash, { xtoysWebhookId: "abc", deadband: 0, pauseKey: "", heartbeatKey: "" });
  await c.client.uploadScript("u"); await c.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  c.player.t = 0.5; c.tick();
  const d = c.sent.filter(m => m.action === "axes").pop();
  eq("a channel named payload survives when the copy is off", d.payload, "50");
}

console.log("\n" + passes + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
