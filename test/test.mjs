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
    setInterval: (fn) => { tickFn = fn; return 1; },
    clearInterval: () => { tickFn = null; },
    fetch: async () => ({ ok: true, json: async () => funscript }),
    window: { PluginApi: { utils: { InteractiveUtils } }, location: { href: "http://localhost:9999/scenes/1" } },
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
  return { client, sent, raw, conns, FakeWS, player, handyBuilt, tick: () => tickFn && tickFn(), hasTick: () => !!tickFn };
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
  eq("channel names verbatim (+stroke, no Handy here)", Object.keys(m).sort(), ["pitch","roll","stroke"]);
  eq("roll interpolated at 500ms", m.roll, "50");
  eq("pitch interpolated at 500ms", m.pitch, "35");
}

// ---- 2. v1.1 axes --------------------------------------------------------
console.log("\nv1.1 axes array");
{
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0 });
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
  const e = makeEnv(V10, { xtoysWebhookId: "abc" }, {}, handy);
  await e.client.uploadScript("u"); await e.client.play(0);
  ok("with a Handy, stroke-only script routes nothing", !e.hasTick());
  eq("nothing sent", e.sent.length, 0);

  const e2 = makeEnv(V10, { xtoysWebhookId: "abc", deadband: 0 });
  await e2.client.uploadScript("u"); await e2.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  ok("without a Handy, stroke IS routed", e2.hasTick());
  e2.player.t = 0.5; e2.tick();
  eq("stroke value sent", e2.sent[e2.sent.length-1].stroke, "50");
}

// ---- 4. seeking ----------------------------------------------------------
console.log("\nseek");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
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
  ok("ticker cleared", !e.hasTick());
  ok("a final frame was sent on stop", e.sent.length > 0);
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
  eq("inverted flips 100 -> 0", m.roll, "0");
  eq("range 50 scales 50 -> 100", m.pitch, "100");
}

// ---- 10. offset + axis filter -------------------------------------------
console.log("\noffset + axis filter");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "roll", offsetMs: 500 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.0; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("filtered to roll only", Object.keys(m).sort(), ["roll"]);
  eq("offset applied (t=0 +500ms)", m.roll, "50");
}
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 }, { funscriptOffset: 1000 });
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
  const e = makeEnv(custom, { xtoysWebhookId: "abc", deadband: 0 });
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
  const e = makeEnv(V11, { xtoysWebhookId: "abc", deadband: 0, axes: "roll" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  eq("'roll' selects the R1 channel", Object.keys(e.sent[e.sent.length-1]).sort(), ["R1"]);

  const e2 = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, axes: "R2" });
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
  const e = makeEnv(dup, { xtoysWebhookId: "abc", deadband: 0 });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  e.player.t = 0.5; e.tick();
  const m = e.sent[e.sent.length - 1];
  eq("R1 and roll collapse to one axis", Object.keys(m).sort(), ["R1"]);
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
  eq("stroke excluded, aux still routed", Object.keys(m).sort(), ["pitch","roll"]);
}


// ---- 16. stroke axis ownership ------------------------------------------
console.log("\nstroke axis owner");
{
  const mkHandy = () => ({ handyKey: "REALKEY", connected: true, playing: false,
    connect: () => Promise.resolve(), sync: () => Promise.resolve(0), configure: () => Promise.resolve(),
    uploadScript: () => Promise.resolve(), play: () => Promise.resolve(), pause: () => Promise.resolve(),
    ensurePlaying: () => Promise.resolve(), setLooping: () => Promise.resolve() });

  // router: must decline the Handy outright, not merely ignore its output
  const r = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0, strokeAxis: "router" }, {}, mkHandy());
  await r.client.uploadScript("u"); await r.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  r.player.t = 0.5; r.tick();
  eq("router: Handy never constructed", r.handyBuilt.n, 0);
  eq("router: stroke routed alongside aux", Object.keys(r.sent[r.sent.length-1]).sort(),
     ["pitch","roll","stroke"]);
  eq("router: sentinel key so the pipeline runs", r.client.handyKey, "funscriptAxisRouter");

  // handy: always delegated, stroke withheld
  const h = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0, strokeAxis: "handy" }, {}, mkHandy());
  await h.client.uploadScript("u"); await h.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  h.player.t = 0.5; h.tick();
  eq("handy: Handy constructed", h.handyBuilt.n, 1);
  eq("handy: stroke withheld", Object.keys(h.sent[h.sent.length-1]).sort(),
     ["pitch","roll"]);

  // handy with no key: nobody plays stroke
  const hn = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0, strokeAxis: "handy" });
  await hn.client.uploadScript("u"); await hn.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  hn.player.t = 0.5; hn.tick();
  eq("handy+no key: stroke still withheld", Object.keys(hn.sent[hn.sent.length-1]).sort(),
     ["pitch","roll"]);

  // auto still behaves exactly as before
  const a1 = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0, strokeAxis: "auto" }, {}, mkHandy());
  await a1.client.uploadScript("u"); await a1.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  a1.player.t = 0.5; a1.tick();
  eq("auto+handy: stroke withheld", Object.keys(a1.sent[a1.sent.length-1]).sort(),
     ["pitch","roll"]);

  const a2 = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0 });
  await a2.client.uploadScript("u"); await a2.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  a2.player.t = 0.5; a2.tick();
  eq("auto+no handy (default): stroke routed", Object.keys(a2.sent[a2.sent.length-1]).sort(),
     ["pitch","roll","stroke"]);

  // garbage falls back to auto rather than breaking
  const bad = makeEnv(V2, { xtoysWebhookId: "a", deadband: 0, strokeAxis: "nonsense" }, {}, mkHandy());
  await bad.client.uploadScript("u"); await bad.client.play(0);
  await new Promise(x => setTimeout(x, 5));
  bad.player.t = 0.5; bad.tick();
  eq("invalid value falls back to auto", Object.keys(bad.sent[bad.sent.length-1]).sort(),
     ["pitch","roll"]);
}


// ---- 17. wire format ----------------------------------------------------
console.log("\nwire format");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
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
  const hold = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0 });
  await hold.client.uploadScript("u"); await hold.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  hold.player.t = 0.5; hold.tick();
  const before = hold.sent[hold.sent.length - 1];
  await hold.client.pause();
  eq("blank holds the last values", hold.sent[hold.sent.length - 1], before);

  const park = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, stopValue: 0 });
  await park.client.uploadScript("u"); await park.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  park.player.t = 0.5; park.tick();
  await park.client.pause();
  const m = park.sent[park.sent.length - 1];
  eq("stopValue 0 parks every channel", Object.keys(m).sort().map(k => k + "=" + m[k]),
     ["pitch=0","roll=0","stroke=0"]);
}

// ---- 19. token auth fallback --------------------------------------------
console.log("\ntoken auth");
{
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysToken: "TOK" });
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  eq("first attempt offers the token as a subprotocol", e.conns[0].protocols, ["Bearer", "TOK"]);
  eq("first attempt keeps the plain url", e.conns[0].url, "wss://webhook.xtoys.app/abc");
}
{
  // server refuses every connection: must walk subprotocol -> query -> none
  const e = makeEnv(V2, { xtoysWebhookId: "abc", deadband: 0, xtoysToken: "TOK" });
  e.FakeWS.rejectAll = true;
  await e.client.uploadScript("u"); await e.client.play(0);
  await new Promise(r => setTimeout(r, 5));
  for (let i = 0; i < 3; i++) { e.FakeWS.lastRetry && e.FakeWS.lastRetry(); await new Promise(r => setTimeout(r, 1200)); }
  const names = e.conns.map(c => c.protocols ? "subprotocol" : (c.url.includes("token=") ? "query" : "none"));
  ok("tries subprotocol first", names[0] === "subprotocol", names);
  ok("falls back to query", names.includes("query"), names);
  e.FakeWS.rejectAll = false;
}

console.log("\n" + passes + " passed, " + fails + " failed");
process.exit(fails ? 1 : 0);
