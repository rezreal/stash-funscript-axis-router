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

var WEBHOOK = "webhook-a"; /* channel name of the Webhook block */
var ACTION = "axes";       /* must match the plugin's XToys Action Name */
var RAMP_MS = 100;         /* smoothing between updates; ~one update interval */

/* Read the mapping from textbox Controls named channel1..channel8 instead of
 * the list above. Set to true only if you actually created those Controls. */
var USE_CONTROLS = false;

/* --------------------------------------------------------------- internals */

var halted = false;

function channelFor(i) {
  if (!USE_CONTROLS) return OUTPUTS[i].channel;
  var v = getVariable("channel" + (i + 1));
  return v === undefined || v === null ? "" : String(v);
}

function setOutput(toy, percent) {
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

function onHeartbeat(data) {
  /* Liveness only. The deadman switch itself is the Watchdog Job - see the
   * README: JavaScript here has no timer of its own, and sleep() would block
   * the interpreter. */
}

registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: ACTION }, onAxes);
registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "pause" }, onPause);
registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "heartbeat" }, onHeartbeat);

stopAll();
console.log("funscript axis router ready, " + OUTPUTS.length + " outputs");
