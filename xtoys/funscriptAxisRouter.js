/* Funscript Axis Router - XToys side
 *
 * Paste into the XToys JavaScript editor: open the Script, then the JS button
 * in the top toolbar.
 *
 * Setup:
 *   1. Connect a Webhook block and one toy per output you want, then set
 *      WEBHOOK and TOYS below to their channel names. Both are in the
 *      channels: {} section of your Script Export.
 *   2. Add an input Control per output, named out1, out2, out3, ...
 *   3. Type a funscript channel name into each - roll, pitch, e-stim, whatever
 *      your file contains. The stash plugin logs the channels it routes.
 *
 * Outputs are paired with the Controls in order: the first toy in TOYS follows
 * out1, the second out2, and so on. The startup log prints the pairing.
 *
 * ES5 only. JS-Interpreter is not a full ES5 engine: no let/const, no arrow
 * functions, no template literals, no anonymous nested functions, no DOM.
 */

/* ------------------------------------------------------------------ config */

/* Channel names, straight from the channels: {} section of your Script Export.
 * These are NOT discovered: getConnectedBlocks() has been observed returning an
 * object keyed by channel name in one script and a plain array in another, and
 * calling callAction() with a channel that does not exist crashes XToys
 * internally ("can't access property isToy"). Explicit is safer. */
var WEBHOOK = "webhook-a";

/* One entry per output, in order: the first follows Control out1, the second
 * out2, and so on. Comma separated, no spaces. */
var TOYS = "generic-1-a,generic-1-b,generic-1-c";
var ACTION = "axes";         /* must match the plugin's Action Name setting */
var RAMP_MS = 100;           /* fallback if the rampMs Control is empty */
var CUSTOM_TOY_KEY = "a";    /* which key a custom toy's setValue writes to */
var CONTROL_PREFIX = "out";  /* Controls named out1, out2, ... hold channel names */

/* --------------------------------------------------------------- discovery */

var OUTS = TOYS === "" ? [] : TOYS.split(",");

/* getConnectedBlocks() is deliberately not called. What it returns is a native
 * object the interpreter will not marshal - JSON.stringify on it yields
 * "[object Object],getConnectedBlocks" and raises "Object is not pseudo" - and
 * its shape is inconsistent between scripts anyway. Read your channel names off
 * the Script Export instead. */

/* --------------------------------------------------------------- internals */

var halted = false;
var announced = false;

/* Read live rather than cached, so editing a Control takes effect immediately
 * without reloading the script. */
function channelFor(i) {
  var v = getVariable(CONTROL_PREFIX + (i + 1));
  if (v === undefined || v === null) return "";
  return String(v);
}

/* Toy types do not share one interface. A generic toy takes setVolume with a
 * percentVolume; a custom toy takes setValue with a key, as seen in a real
 * script export. Anything unrecognised is treated as a generic toy. */
function setOutput(toy, percent) {
  if (!toy) return;
  try {
    setOutputUnsafe(toy, percent);
  } catch (e) {
    console.log("could not drive '" + toy + "': " + e +
                " - check it against the channels in your Script Export");
  }
}

function rampSeconds() {
  var v = parseFloat(getVariable("rampMs"));
  if (isNaN(v) || v < 0) v = RAMP_MS;
  return v / 1000;
}

function setOutputUnsafe(toy, percent) {
  if (toy.indexOf("generic-custom-toy") === 0) {
    callAction({
      type: "updateComponent",
      channel: toy,
      action: "setValue",
      key: CUSTOM_TOY_KEY,
      value: String(percent)
    });
    return;
  }

  callAction({
    type: "updateComponent",
    channel: toy,
    action: "setVolume",
    rampTime: rampSeconds(),
    percentVolume: String(percent)
  });
}

function stopAll() {
  for (var i = 0; i < OUTS.length; i++) {
    setOutput(OUTS[i], 0);
  }
}

/* The trigger callback gets the whole message as trigger-<key>, so a channel
 * whose name was only typed into a Control at runtime can be read directly. */
function readValue(data, name) {
  if (!name) return null;
  var raw = data["trigger-" + name];
  if (raw === undefined || raw === null || raw === "") return null;
  var v = parseFloat(raw);
  if (isNaN(v)) return null;
  if (v < 0) v = 0;
  if (v > 100) v = 100;
  return Math.round(v);
}

function onAxes(data) {
  if (halted) return;
  for (var i = 0; i < OUTS.length; i++) {
    var v = readValue(data, channelFor(i));
    if (v !== null) setOutput(OUTS[i], v);
  }
}

function onPause(data) {
  halted = String(data["trigger-pause"]) === "1";
  if (halted) /* Seed the numeric Controls so they show real values instead of empty boxes. */
function seed(name, value) {
  var v = getVariable(name);
  if (v === undefined || v === null || String(v) === "") setVariable(name, value);
}

seed("rampMs", RAMP_MS);
seed("skipSeconds", 30);

console.log("remote controls to add (name:type): " + CONTROLS);

stopAll();
}

function onHeartbeat(data) {
  /* Liveness only. The deadman switch is the Watchdog Job - JavaScript here has
   * no timer, and sleep() would block the interpreter. */
}

/* ------------------------------------------------------------------ remote */

function clock(total) {
  total = Math.max(0, Math.round(total));
  var m = Math.floor(total / 60);
  var sec = total % 60;
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

function onStatus(data) {
  setVariable("videoTitle", data["trigger-title"] || "");
  setVariable("videoPosition", data["trigger-position"] || "0");
  setVariable("videoDuration", data["trigger-duration"] || "0");
  setVariable("videoPlaying", data["trigger-playing"] || "0");

  var pos = parseFloat(data["trigger-position"]) || 0;
  var dur = parseFloat(data["trigger-duration"]) || 0;
  setVariable("videoPercent", dur > 0 ? Math.round((pos / dur) * 100) : 0);
  setVariable("videoElapsed", clock(pos) + " / " + clock(dur));

  /* What this scene actually carries, so you can see which names are worth
   * putting in the out1..outN Controls instead of guessing. Display it with a
   * Control bound to videoChannels. */
  var chans = data["trigger-channels"] || "";
  if (chans !== lastChannels) {
    lastChannels = chans;
    setVariable("videoChannels", chans);
    console.log("channels in this scene: " + (chans === "" ? "(none)" : chans));
  }
}

var lastChannels = null;

/* Needs "Script can send outbound messages" ticked on the webhook connection.
 *
 * UNVERIFIED: the Action shape for an outbound webhook message is not in the
 * docs. If the buttons do nothing, use 'Add XToys Action' in the JS editor with
 * the webhook block selected to get the real JSON and fix this one function. */
var sendFailed = false;

function sendToStash(msg) {
  msg.channel = WEBHOOK;
  try {
    callAction(msg);
  } catch (e) {
    if (!sendFailed) {
      sendFailed = true;
      console.log("sending to stash failed: " + e +
                  " - use 'Add XToys Action' in this editor with the webhook " +
                  "block selected to get the correct JSON, then fix sendToStash()");
    }
  }
}

function play()     { sendToStash({ type: "updateComponent", action: "send", data: { action: "play" } }); }
function pause()    { sendToStash({ type: "updateComponent", action: "send", data: { action: "pause" } }); }
function toggle()   { sendToStash({ type: "updateComponent", action: "send", data: { action: "toggle" } }); }
function skip(secs) { sendToStash({ type: "updateComponent", action: "send", data: { action: "skip", seconds: secs } }); }
function seekPct(p) { sendToStash({ type: "updateComponent", action: "send", data: { action: "seek", percent: p } }); }

function onPlay()  { play(); }
function onPause() { pause(); }
function skipAmount() {
  var v = parseFloat(getVariable("skipSeconds"));
  return isNaN(v) || v <= 0 ? 30 : v;
}

function onRewind()  { skip(-skipAmount()); }
function onForward() { skip(skipAmount()); }
function onSeek()    { seekPct(parseFloat(getVariable("Seek")) || 0); }

/* ---------------------------------------------------------------- dispatch */

/* One trigger for everything, dispatched here on trigger-action. The callback
 * gets no way to tell which registered trigger fired, so an action-filtered
 * trigger and a bare one that fires for everything look identical - there was
 * never evidence the filtering worked. The action arrives in the data anyway. */
function onMessage(data) {
  if (!announced) {
    announced = true;
    var body = "";
    for (var k in data) { body = body + k + "=" + data[k] + "  "; }
    console.log("first message: " + body);
  }

  var action = String(data["trigger-action"] || "");
  if (action === ACTION) onAxes(data);
  else if (action === "pause") onPause(data);
  else if (action === "status") onStatus(data);
  else if (action === "heartbeat") onHeartbeat(data);
}

registerTrigger({ type: "componentState", channel: WEBHOOK }, onMessage);

/* A Control's name is both the variable it sets and the text shown on it, so
 * these are named for how they should read in the UI. */
registerTrigger({ type: "variableChange", variable: "Play" },    onPlay);
registerTrigger({ type: "variableChange", variable: "Pause" },   onPause);
registerTrigger({ type: "variableChange", variable: "Rewind" },  onRewind);
registerTrigger({ type: "variableChange", variable: "Forward" }, onForward);
registerTrigger({ type: "variableChange", variable: "Seek" },    onSeek);

/* Controls the remote expects, so a missing one is obvious rather than just
 * being a button that does nothing. */
var CONTROLS = "Play:push, Pause:push, Rewind:push, Forward:push, " +
               "Seek:slider  |  advanced: skipSeconds:input, rampMs:input";

/* ------------------------------------------------------------------ report */

console.log("listening on '" + WEBHOOK + "'");

if (OUTS.length === 0) {
  console.log("TOYS is empty - set it to your toy channel names");
} else {
  var summary = "";
  for (var s = 0; s < OUTS.length; s++) {
    var name = channelFor(s);
    summary = summary + "  " + CONTROL_PREFIX + (s + 1) + " (" + OUTS[s] + ") -> " +
              (name === "" ? "(unset)" : name) + "\n";
  }
  console.log("output mapping:\n" + summary);
}

stopAll();
