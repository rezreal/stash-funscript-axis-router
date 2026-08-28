/* Funscript Axis Router - XToys side
 *
 * Paste into the XToys JavaScript editor: open the Script, then the JS button
 * in the top toolbar.
 *
 * Setup:
 *   1. Connect a Webhook block and one toy per output, then set WEBHOOK and
 *      TOYS below from the channels: {} section of your Script Export.
 *   2. Add input Controls named out1, out2, ... one per output.
 *   3. Type a funscript channel name into each. The Channels Control lists
 *      what the current scene actually carries.
 *
 * ES5 only. JS-Interpreter is not a full ES5 engine: no let/const, no arrow
 * functions, no template literals, no anonymous nested functions, no DOM.
 */

/* ------------------------------------------------------------------ config */

/* Channel names are NOT discovered. getConnectedBlocks() returns an object
 * keyed by channel in one script and a plain array in another, will not
 * marshal through the interpreter, and calling callAction() with a channel
 * that does not exist crashes XToys internally. Set these by hand. */
/* The channel KEY, not the block's display name. In a Script Export the
 * channels: {} section reads
 *     "webhook-a": { "name": "stash", "type": "webhook" }
 * so this is "webhook-a" - "stash" is only the label. Setting the name here
 * fails silently: the trigger registers and never fires. */
var WEBHOOK = "webhook-a";
var TOYS = "generic-1-a,generic-1-b,generic-1-c";

var ACTION = "axes";        /* must match the plugin's Action Name setting */
var RAMP_MS = 100;          /* fallback when the rampMs Control is empty */
var SKIP_SECONDS = 30;      /* fallback when the skipSeconds Control is empty */
var CUSTOM_TOY_KEY = "a";   /* key a custom toy's setValue writes to */
var CONTROL_PREFIX = "out"; /* Controls out1, out2, ... hold channel names */

var OUTS = TOYS === "" ? [] : TOYS.split(",");

/* --------------------------------------------------------------- internals */

var halted = false;
var announced = false;
var lastChannels = null;
var sendFailed = false;

function numVar(name, fallback) {
  var v = parseFloat(getVariable(name));
  return isNaN(v) || v < 0 ? fallback : v;
}

/* Read live so editing a Control takes effect without reloading the script. */
function channelFor(i) {
  var v = getVariable(CONTROL_PREFIX + (i + 1));
  if (v === undefined || v === null) return "";
  return String(v);
}

/* Toy types do not share one interface: a generic toy takes setVolume with a
 * percentVolume, a custom toy takes setValue with a key. */
function driveToy(toy, percent) {
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
    rampTime: numVar("rampMs", RAMP_MS) / 1000,
    percentVolume: String(percent)
  });
}

function setOutput(toy, percent) {
  if (!toy) return;
  try {
    driveToy(toy, percent);
  } catch (e) {
    console.log("could not drive '" + toy + "': " + e +
                " - check it against the channels in your Script Export");
  }
}

function stopAll() {
  for (var i = 0; i < OUTS.length; i++) {
    setOutput(OUTS[i], 0);
  }
}

/* --------------------------------------------------------------- messages */

/* The callback receives the whole message as trigger-<key>, so a channel whose
 * name was only typed into a Control at runtime can be read directly. */
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

function onPauseMessage(data) {
  halted = String(data["trigger-pause"]) === "1";
  if (halted) stopAll();
}

function onHeartbeat(data) {
  /* Liveness only. The deadman switch is the Watchdog Job: JavaScript here has
   * no timer, and sleep() would block the interpreter. */
}

function clock(total) {
  total = Math.max(0, Math.round(total));
  var m = Math.floor(total / 60);
  var sec = total % 60;
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

/* A Control reflects its variable and is labelled with its own name, so adding
 * an input Control called Scene, Elapsed, Playing or Channels displays it. */
function onStatus(data) {
  setVariable("Scene", data["trigger-title"] || "");
  setVariable("Playing", data["trigger-playing"] === "1" ? "playing" : "paused");

  var pos = parseFloat(data["trigger-position"]) || 0;
  var dur = parseFloat(data["trigger-duration"]) || 0;
  setVariable("Elapsed", clock(pos) + " / " + clock(dur));

  /* raw values, for anything doing arithmetic rather than display */
  setVariable("videoPosition", data["trigger-position"] || "0");
  setVariable("videoDuration", data["trigger-duration"] || "0");
  setVariable("videoPercent", dur > 0 ? Math.round((pos / dur) * 100) : 0);

  var chans = data["trigger-channels"] || "";
  if (chans !== lastChannels) {
    lastChannels = chans;
    setVariable("Channels", chans);
    console.log("channels in this scene: " + (chans === "" ? "(none)" : chans));
  }
}

/* ------------------------------------------------------------------ remote */

/* Needs "Script can send outbound messages" ticked on the webhook connection.
 *
 * The shape comes from 'Add XToys Action' with the webhook block selected:
 *   {"type":"updateComponent","channel":"webhook-a","action":"send",
 *    "webhookAction":"ACTION_NAME","format":"raw","webhookData":"DATA"}
 * so the action name travels in webhookAction, not alongside the payload. */
function send(action, extra) {
  var data = "";
  if (extra) {
    for (var k in extra) {
      data = data + (data === "" ? "" : "&") + k + "=" + extra[k];
    }
  }

  try {
    callAction({
      type: "updateComponent",
      channel: WEBHOOK,
      action: "send",
      webhookAction: action,
      format: "raw",
      webhookData: data
    });
  } catch (e) {
    if (!sendFailed) {
      sendFailed = true;
      console.log("sending to stash failed: " + e);
    }
  }
}

/* Button handlers. Named distinctly from the message handlers above - onPause
 * previously meant both, which silently broke pause handling. */
function onPlayButton()    { send("play"); }
function onPauseButton()   { send("pause"); }
function onRewindButton()  { send("skip", { seconds: -numVar("skipSeconds", SKIP_SECONDS) }); }
function onForwardButton() { send("skip", { seconds: numVar("skipSeconds", SKIP_SECONDS) }); }
function onSeekControl()   { send("seek", { percent: numVar("Seek", 0) }); }

/* ---------------------------------------------------------------- dispatch */

/* One trigger for everything, dispatched on trigger-action. The callback is
 * given no way to tell which registered trigger fired, so an action-filtered
 * trigger and a bare one that fires for everything are indistinguishable.
 * Dispatching here needs no assumption and cannot double-fire. */
function onMessage(data) {
  if (!announced) {
    announced = true;
    var body = "";
    for (var k in data) { body = body + k + "=" + data[k] + "  "; }
    console.log("first message: " + body);
  }

  /* Feeds the Watchdog Job, which is the deadman switch: JavaScript has no
   * timer, so the Job counts up and this resets it on every message. If the
   * browser goes away the Job drives everything to zero. */
  setVariable("lastBeat", 0);

  var action = String(data["trigger-action"] || "");
  if (action === ACTION) onAxes(data);
  else if (action === "pause") onPauseMessage(data);
  else if (action === "status") onStatus(data);
  else if (action === "heartbeat") onHeartbeat(data);
}

registerTrigger({ type: "componentState", channel: WEBHOOK }, onMessage);

/* A Control's name is both its variable and its on-screen label. */
registerTrigger({ type: "variableChange", variable: "Play" },    onPlayButton);
registerTrigger({ type: "variableChange", variable: "Pause" },   onPauseButton);
registerTrigger({ type: "variableChange", variable: "Rewind" },  onRewindButton);
registerTrigger({ type: "variableChange", variable: "Forward" }, onForwardButton);
registerTrigger({ type: "variableChange", variable: "Seek" },    onSeekControl);

/* ------------------------------------------------------------------ report */

function seed(name, value) {
  var v = getVariable(name);
  if (v === undefined || v === null || String(v) === "") setVariable(name, value);
}

seed("rampMs", RAMP_MS);
seed("skipSeconds", SKIP_SECONDS);
seed("watchdogMs", 3000);

console.log("listening on '" + WEBHOOK + "'");

if (OUTS.length === 0) {
  console.log("TOYS is empty - set it to your toy channel names");
} else {
  var summary = "";
  for (var s = 0; s < OUTS.length; s++) {
    var mapped = channelFor(s);
    summary = summary + "  " + CONTROL_PREFIX + (s + 1) + " (" + OUTS[s] + ") -> " +
              (mapped === "" ? "(unset)" : mapped) + "\n";
  }
  console.log("output mapping:\n" + summary);
}

console.log("controls: Scene, Elapsed, Playing, Channels (display) | " +
            "out1.." + OUTS.length + " (routing) | " +
            "Play, Pause, Rewind, Forward (push), Seek (slider) | " +
            "skipSeconds, rampMs, watchdogMs (advanced)");

stopAll();
