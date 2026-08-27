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
  const player = { t: 0, isPaused: false, currentTime() { return this.t; }, paused() { return this.isPaused; } };
  let tickFn = null;

  class FakeWS {
    constructor(url) { this.url = url; this.readyState = 1; FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
  }

  const InteractiveUtils = { getPlayer: () => player, interactiveClientProvider: undefined };
  const ctx = {
    console, Promise, JSON, Math, Date, Object, Array, isFinite, parseFloat, URL, Error,
    WebSocket: FakeWS,
    setTimeout, clearTimeout,
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    fetch: async () => ({ ok: true, json: async () => funscript }),
    window: { PluginApi: { utils: { InteractiveUtils } }, location: { href: "http://localhost:9999/scenes/1" } },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);

  const iface = Object.assign({}, ifaceSettings || {});
  if (handy) iface.handyKey = "REALKEY";
  const opts = {
    handyKey: "", scriptOffset: 0,
    defaultClientProvider: handy ? (() => handy) : undefined,
    stashConfig: { interface: iface, plugins: { funscriptAxisRouter: pluginSettings || {} } },
  };
  const client = InteractiveUtils.interactiveClientProvider(opts);
  return { client, sent, player, tick: () => tickFn && tickFn(), hasTick: () => !!tickFn };
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
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("http://localhost:9999/scene/1/funscript");
  await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("interval started", e.hasTick());
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("channel names verbatim (+stroke, no Handy here)", Object.keys(m).sort(), ["action","at","pitch","playing","roll","stroke"]);
  eq("roll interpolated at 500ms", m.roll, 50);
  eq("pitch interpolated at 500ms", m.pitch, 35);
  eq("action name defaults", m.action, "funscript");
  eq("playing flag", m.playing, true);
}

// ---- 2. v1.1 axes --------------------------------------------------------
console.log("\nv1.1 axes array");
{
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.25; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("v1.1 ids sent verbatim", Object.keys(m).sort(), ["L1","R1","action","at","playing","stroke"]);
  eq("R1 at 250ms", m.R1, 25);
}

// ---- 3. v1.0 has no aux --------------------------------------------------
console.log("\nv1.0 single axis");
{
  const handy = { handyKey: "REALKEY", connected: true, playing: false,
    connect: () => Promise.resolve(), sync: () => Promise.resolve(0), configure: () => Promise.resolve(),
    uploadScript: () => Promise.resolve(), play: () => Promise.resolve(), pause: () => Promise.resolve(),
    ensurePlaying: () => Promise.resolve(), setLooping: () => Promise.resolve() };
  const e = makeEnv(V10, { xtoysWebhookId: "abc" }, {}, handy);
  await e.client.uploadScript("u"); await e.client.play(0);
  ok("with a Handy, stroke-only script routes nothing", !e.hasTick());
  eq("nothing sent", e.sent.length, 0);

  const e2 = makeEnv(V10, { xtoysWebhookId: "abc", deadband: 0 });
  await e2.client.uploadScript("u"); await e2.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("without a Handy, stroke IS routed", e2.hasTick());
  e2.player.t = 0.5; e2.tick();
  eq("stroke value sent", e2.sent[e2.sent.length-1].stroke, 50);
}

// ---- 4. seeking ----------------------------------------------------------
console.log("\nseek");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 1.5; e.tick();
  eq("forward jump", e.sent[e.sent.length-1].roll, 50);
  e.player.t = 0.25; e.tick();
  eq("backward seek", e.sent[e.sent.length-1].roll, 25);
  e.player.t = 1.75; e.tick();
  eq("forward again", e.sent[e.sent.length-1].roll, 25);
}

// ---- 5. deadband ---------------------------------------------------------
console.log("\ndeadband");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 10 });
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
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  await e.client.pause();
  const m = e.sent[e.sent.length - 1];
  eq("stop message playing=false", m.playing, false);
  ok("ticker cleared", !e.hasTick());
  e.player.isPaused = true;
}

// ---- 7. no-handy fallbacks ----------------------------------------------
console.log("\nno-handy operation");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc" }, {});
  eq("sentinel handyKey non-empty", e.client.handyKey, "funscriptAxisRouter");
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
  const e = makeEnv(fs2, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 1.0; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("inverted flips 100 -> 0", m.roll, 0);
  eq("range 50 scales 50 -> 100", m.pitch, 100);
}

// ---- 10. offset + axis filter -------------------------------------------
console.log("\noffset + axis filter");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "roll", offsetMs: 500 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.0; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("filtered to roll only", Object.keys(m).sort(), ["action","at","playing","roll"]);
  eq("offset applied (t=0 +500ms)", m.roll, 50);
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 }, { funscriptOffset: 1000 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.0; e.tick();
  eq("falls back to interface.funscriptOffset", e.sent[e.sent.length-1].roll, 100);
}


// ---- 11. arbitrary channel names ----------------------------------------
console.log("\narbitrary channel names");
{
  const custom = { version: "2.0", actions: [{at:0,pos:0},{at:1000,pos:100}], channels: {
    vibe:        { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    "e-stim":    { actions: [{ at: 0, pos: 10 }, { at: 1000, pos: 90 }] },
    R1:          { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 40 }] } } };
  const e = makeEnv(custom, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("unknown names pass through verbatim", Object.keys(m).sort(), ["R1","action","at","e-stim","playing","stroke","vibe"]);
  eq("vibe value", m.vibe, 50);
  eq("e-stim value", m["e-stim"], 50);
  eq("R1 kept as R1, not renamed to roll", m.R1, 20);
}

// ---- 12. reserved names --------------------------------------------------
console.log("\nreserved channel names");
{
  const bad = { version: "2.0", channels: {
    action:  { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    playing: { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] },
    roll:    { actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] } } };
  const e = makeEnv(bad, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("reserved channels skipped", Object.keys(m).sort(), ["action","at","playing","roll"]);
  eq("action still the action name", m.action, "funscript");
  eq("playing still a boolean", m.playing, true);
}

// ---- 13. filter accepts either spelling ----------------------------------
console.log("\nfilter by name or id");
{
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0, axes: "roll" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  eq("'roll' selects the R1 channel", Object.keys(e.sent[e.sent.length-1]).sort(), ["R1","action","at","playing"]);

  const e2 = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "R2" });
  await e2.client.uploadScript("u"); await e2.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e2.player.t = 0.5; e2.tick();
  eq("'R2' selects the pitch channel", Object.keys(e2.sent[e2.sent.length-1]).sort(), ["action","at","pitch","playing"]);
}

// ---- 14. dedupe across containers ---------------------------------------
console.log("\ndedupe axes vs channels");
{
  const dup = { version: "2.0",
    axes: [{ id: "R1", actions: [{ at: 0, pos: 0 }, { at: 1000, pos: 100 }] }],
    channels: { roll: { actions: [{ at: 0, pos: 100 }, { at: 1000, pos: 0 }] } } };
  const e = makeEnv(dup, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("R1 and roll collapse to one axis", Object.keys(m).sort(), ["R1","action","at","playing"]);
}


// ---- 15. with a Handy, stroke is withheld --------------------------------
console.log("\nstroke withheld when a Handy owns it");
{
  const handy = { handyKey: "REALKEY", connected: true, playing: false,
    connect: () => Promise.resolve(), sync: () => Promise.resolve(0), configure: () => Promise.resolve(),
    uploadScript: () => Promise.resolve(), play: () => Promise.resolve(), pause: () => Promise.resolve(),
    ensurePlaying: () => Promise.resolve(), setLooping: () => Promise.resolve() };
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 }, {}, handy);
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("stroke excluded, aux still routed", Object.keys(m).sort(), ["action","at","pitch","playing","roll"]);
}

console.log("\n" + passes + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
