/* Funscript Axis Router - XToys side
 *
 * Paste this into the XToys JavaScript editor: open the Script, then the JS
 * button in the top toolbar. No import needed, which is the point - XToys has
 * no documented way to import a script JSON.
 *
 * Blocks to connect first: a Webhook tool, and one Generic toy per output you
 * want. Put the Webhook ID into the stash plugin's XToys Webhook ID setting.
 *
 * ES5 only. The XToys JS runs under JS-Interpreter: no let/const, no arrow
 * functions, no template literals, no DOM.
 */

/* ------------------------------------------------------------------ config */

/* One entry per output. `channel` is the funscript channel name exactly as it
 * appears in the file - the stash plugin logs the channels it routes, so check
 * the browser console if you are unsure. Leave a channel "" to skip that
 * output. `toy` is the XToys channel name of the connected toy; check the
 * channels: {} section of the Script Export if yours are named differently. */
var OUTPUTS = [
  { channel: "stroke", toy: "generic-1-a" },
  { channel: "surge",  toy: "generic-1-b" },
  { channel: "sway",   toy: "generic-1-c" },
  { channel: "twist",  toy: "generic-1-d" },
  { channel: "roll",   toy: "generic-1-e" },
  { channel: "pitch",  toy: "generic-1-f" },
  { channel: "",       toy: "generic-1-g" },
  { channel: "",       toy: "generic-1-h" }
];

/* Channel name of the Webhook block. Leave "" to detect it from the connected
 * blocks - the name depends on which slot the block occupies, and guessing it
 * wrong is silent: triggers register happily against a channel that does not
 * exist and simply never fire. */
var WEBHOOK = "";
var ACTION = "axes";       /* must match the plugin's XToys Action Name */
var RAMP_MS = 100;         /* smoothing between updates; ~one update interval */

/* Read the mapping from textbox Controls named channel1..channel8 instead of
 * the list above. Set to true only if you actually created those Controls. */
var USE_CONTROLS = false;

/* --------------------------------------------------------------- internals */

var halted = false;

function findWebhook() {
  if (WEBHOOK) return WEBHOOK;

  var blocks = {};
  try {
    blocks = getConnectedBlocks() || {};
  } catch (e) {
    console.log("could not list connected blocks: " + e);
    return "webhook-a";
  }

  var names = [];
  for (var ch in blocks) {
    if (!blocks.hasOwnProperty(ch)) continue;
    names.push(ch);
    if (ch.indexOf("webhook") === 0) return ch;
  }

  console.log(
    "no webhook block found among: " + names.join(", ") +
    " - add a Webhook block and connect it to the script. A custom-websocket " +
    "toy will not work: it does not deliver messages to script triggers."
  );
  return "webhook-a";
}

WEBHOOK = findWebhook();
console.log("listening on channel '" + WEBHOOK + "'");

/* Outputs the script is allowed to drive. Anything in OUTPUTS that is not a
 * connected block is skipped rather than throwing on every frame - the default
 * list runs to eight and most setups have fewer. */
var available = {};
var missing = "";
try {
  var connected = getConnectedBlocks() || {};
  for (var b in connected) { available[b] = true; }
} catch (e2) {
  for (var m = 0; m < OUTPUTS.length; m++) available[OUTPUTS[m].toy] = true;
}
for (var o = 0; o < OUTPUTS.length; o++) {
  if (OUTPUTS[o].channel && !available[OUTPUTS[o].toy]) {
    missing = missing + OUTPUTS[o].toy + " ";
  }
}
if (missing) {
  console.log("mapped but not connected, will be skipped: " + missing);
}

function channelFor(i) {
  if (!USE_CONTROLS) return OUTPUTS[i].channel;
  var v = getVariable("channel" + (i + 1));
  return v === undefined || v === null ? "" : String(v);
}

function setOutput(toy, percent) {
  if (!available[toy]) return;
  callAction({
    type: "updateComponent",
    channel: toy,
    action: "setVolume",
    rampTime: RAMP_MS / 1000,
    percentVolume: String(percent)
  });
}

function stopAll() {
  for (var i = 0; i < OUTPUTS.length; i++) {
    setOutput(OUTPUTS[i].toy, 0);
  }
}

/* The trigger callback receives the whole message as trigger-<key>, so a
 * channel name only known at runtime can be looked up directly. */
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
  for (var i = 0; i < OUTPUTS.length; i++) {
    var v = readValue(data, channelFor(i));
    if (v !== null) setOutput(OUTPUTS[i].toy, v);
  }
}

function onPause(data) {
  halted = String(data["trigger-pause"]) === "1";
  if (halted) stopAll();
}

/* ---------------------------------------------------------------- remote */

/* Status the plugin publishes about once a second. These land in XToys
 * variables, so any Control that displays a variable can show them. */
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

function clock(total) {
  total = Math.max(0, Math.round(total));
  var m = Math.floor(total / 60);
  var sec = total % 60;
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

/* Sending back to the plugin needs "Script can send outbound messages" ticked
 * on the webhook connection, and only works over a websocket.
 *
 * UNVERIFIED: the exact Action shape for an outbound webhook message is not in
 * the docs. If these do nothing, use 'Add XToys Action' in the JS editor with
 * the webhook block selected to get the real JSON, and fix this one function -
 * everything else routes through it. */
function sendToStash(msg) {
  msg.channel = WEBHOOK;
  callAction(msg);
}

function play()      { sendToStash({ type: "updateComponent", action: "send", data: { action: "play" } }); }
function pause()     { sendToStash({ type: "updateComponent", action: "send", data: { action: "pause" } }); }
function toggle()    { sendToStash({ type: "updateComponent", action: "send", data: { action: "toggle" } }); }
function skip(secs)  { sendToStash({ type: "updateComponent", action: "send", data: { action: "skip", seconds: secs } }); }
function seekPct(p)  { sendToStash({ type: "updateComponent", action: "send", data: { action: "seek", percent: p } }); }

/* Add push Controls with these names and they become remote buttons. A push
 * Control sets its variable, which is what fires these. */
/* Named top-level functions rather than inline ones: JS-Interpreter is not a
 * full ES5 engine and handles anonymous nested functions poorly. */
function onBtnPlay()   { play(); }
function onBtnPause()  { pause(); }
function onBtnToggle() { toggle(); }
function onBtnBack()   { skip(-30); }
function onBtnFwd()    { skip(30); }
function onSeek()      { seekPct(parseFloat(getVariable("seekPercent")) || 0); }

registerTrigger({ type: "variableChange", variable: "btnPlay" },   onBtnPlay);
registerTrigger({ type: "variableChange", variable: "btnPause" },  onBtnPause);
registerTrigger({ type: "variableChange", variable: "btnToggle" }, onBtnToggle);
registerTrigger({ type: "variableChange", variable: "btnBack" },   onBtnBack);
registerTrigger({ type: "variableChange", variable: "btnFwd" },    onBtnFwd);

/* A slider Control named seekPercent scrubs the video. */
registerTrigger({ type: "variableChange", variable: "seekPercent" }, onSeek);

function onHeartbeat(data) {
  /* Liveness only. The deadman switch itself is the Watchdog Job - see the
   * README: JavaScript here has no timer of its own, and sleep() would block
   * the interpreter. */
}

/* One trigger for everything, dispatched here on trigger-action.
 *
 * Registering action-filtered triggers appeared to work, but the callback gets
 * no way to tell which one fired, so there was no evidence the filtering was
 * real - a bare trigger firing for every message looks identical. Since the
 * action arrives as trigger-action anyway, dispatching here needs no such
 * assumption, and one trigger cannot double-fire. */
function onMessage(data) {
  var action = String(data["trigger-action"] || "");

  if (!announced) {
    announced = true;
    var body = "";
    for (var k in data) { body = body + k + "=" + data[k] + "  "; }
    console.log("first message: " + body);
  }

  if (action === ACTION) onAxes(data);
  else if (action === "pause") onPause(data);
  else if (action === "status") onStatus(data);
  else if (action === "heartbeat") onHeartbeat(data);
}

var announced = false;

registerTrigger({ type: "componentState", channel: WEBHOOK }, onMessage);

stopAll();
console.log("funscript axis router ready, " + OUTPUTS.length + " outputs");
