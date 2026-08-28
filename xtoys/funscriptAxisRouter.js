/* Funscript Axis Router - XToys side
 *
 * Paste into the XToys JavaScript editor: open the Script, then the JS button
 * in the top toolbar.
 *
 * Setup:
 *   1. Connect a Webhook block and one toy per output you want. Any toy type
 *      works; they are discovered, not hardcoded.
 *   2. Add an input Control per output, named out1, out2, out3, ...
 *   3. Type a funscript channel name into each - roll, pitch, e-stim, whatever
 *      your file contains. The stash plugin logs the channels it routes.
 *
 * Outputs are paired with the Controls in order: the first connected toy follows
 * out1, the second out2, and so on. The startup log prints the pairing.
 *
 * ES5 only. JS-Interpreter is not a full ES5 engine: no let/const, no arrow
 * functions, no template literals, no anonymous nested functions, no DOM.
 */

/* ------------------------------------------------------------------ config */

var WEBHOOK = "";            /* "" = detect the webhook block automatically */
var ACTION = "axes";         /* must match the plugin's Action Name setting */
var RAMP_MS = 100;           /* smoothing between updates; ~one update interval */
var CUSTOM_TOY_KEY = "a";    /* which key a custom toy's setValue writes to */
var CONTROL_PREFIX = "out";  /* Controls named out1, out2, ... hold channel names */

/* --------------------------------------------------------------- discovery */

var blocks = {};
try {
  blocks = getConnectedBlocks() || {};
} catch (e) {
  console.log("getConnectedBlocks() failed: " + e);
}

function findWebhook() {
  if (WEBHOOK) return WEBHOOK;
  var found = "";
  var all = "";
  for (var ch in blocks) {
    all = all + ch + " ";
    if (!found && ch.indexOf("webhook") === 0) found = ch;
  }
  if (!found) {
    console.log("no webhook block among: " + all +
                "- add a Webhook block and connect it to the script.");
    return "webhook-a";
  }
  return found;
}

/* Every connected block except the webhook is an output, whatever type it is.
 * Built by concatenation rather than array push: JS-Interpreter is unreliable
 * with locally scoped arrays, but split() on a string works. */
function findOutputs() {
  var csv = "";
  for (var ch in blocks) {
    if (ch === WEBHOOK) continue;
    if (ch.indexOf("webhook") === 0) continue;
    csv = csv === "" ? ch : csv + "," + ch;
  }
  return csv;
}

WEBHOOK = findWebhook();

var OUT_CSV = findOutputs();
var OUTS = OUT_CSV === "" ? [] : OUT_CSV.split(",");

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
    rampTime: RAMP_MS / 1000,
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
  if (halted) stopAll();
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
}

/* Needs "Script can send outbound messages" ticked on the webhook connection.
 *
 * UNVERIFIED: the Action shape for an outbound webhook message is not in the
 * docs. If the buttons do nothing, use 'Add XToys Action' in the JS editor with
 * the webhook block selected to get the real JSON and fix this one function. */
function sendToStash(msg) {
  msg.channel = WEBHOOK;
  callAction(msg);
}

function play()     { sendToStash({ type: "updateComponent", action: "send", data: { action: "play" } }); }
function pause()    { sendToStash({ type: "updateComponent", action: "send", data: { action: "pause" } }); }
function toggle()   { sendToStash({ type: "updateComponent", action: "send", data: { action: "toggle" } }); }
function skip(secs) { sendToStash({ type: "updateComponent", action: "send", data: { action: "skip", seconds: secs } }); }
function seekPct(p) { sendToStash({ type: "updateComponent", action: "send", data: { action: "seek", percent: p } }); }

function onBtnPlay()   { play(); }
function onBtnPause()  { pause(); }
function onBtnToggle() { toggle(); }
function onBtnBack()   { skip(-30); }
function onBtnFwd()    { skip(30); }
function onSeek()      { seekPct(parseFloat(getVariable("seekPercent")) || 0); }

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

registerTrigger({ type: "variableChange", variable: "btnPlay" },   onBtnPlay);
registerTrigger({ type: "variableChange", variable: "btnPause" },  onBtnPause);
registerTrigger({ type: "variableChange", variable: "btnToggle" }, onBtnToggle);
registerTrigger({ type: "variableChange", variable: "btnBack" },   onBtnBack);
registerTrigger({ type: "variableChange", variable: "btnFwd" },    onBtnFwd);
registerTrigger({ type: "variableChange", variable: "seekPercent" }, onSeek);

/* ------------------------------------------------------------------ report */

console.log("listening on '" + WEBHOOK + "'");

if (OUTS.length === 0) {
  console.log("no toys connected - connect one per output you want");
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
