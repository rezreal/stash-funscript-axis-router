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
 * The Controls, and what each is for:
 *
 *   Output N channel (out1..out8)
 *     One funscript channel name each. Load a scene first and read
 *     "Channels (reported)" - it lists what that scene actually carries, so
 *     the names can be copied rather than guessed. Output 1..8 drive the toys
 *     in TOYS order; a blank field leaves that output alone. These eight are
 *     the only Controls remembered after the Script stops, via
 *     persistentVariables in the manifest.
 *
 *     A single-axis funscript has no channel name in the file, so it arrives
 *     as MAIN. Every other name is verbatim from the funscript.
 *
 *   Output N invert (inv1..inv8)
 *     Flips that output: the funscript's 0 drives the toy to 100 and back.
 *     Per output rather than per channel, so the same channel can drive two
 *     toys in opposite directions. Read live, so it takes effect on the next
 *     point without a reload, and remembered like the channel names.
 *
 *     It does not flip the zero that a pause or the Watchdog drives - that is
 *     a safety floor rather than a position, and flipping it would turn a stop
 *     into a toy at full.
 *
 *   Scene, Elapsed, Rate, State, Channels (reported)
 *     Display only. They are text inputs because XToys has no read-only
 *     Control, so they can be typed into, but the next status message
 *     overwrites that within about a second. They clear when stash stops
 *     sending - State reads "disconnected" - rather than sitting there
 *     implying something is still playing.
 *
 *   Play, Pause, Rewind, Forward, Seek %, Speed
 *     Drive the stash player. Rewind and Forward jump by skipSeconds; Speed
 *     is playback rate, where 43% is 1x. All of these need "Script can send
 *     outbound messages" ticked on the webhook connection - without it the
 *     console still logs the press and nothing reaches stash. This is the one
 *     part that has never been confirmed working against a real setup.
 *
 *   rampMs, watchdogMs, skipSeconds (advanced)
 *     rampMs is now only a floor. Each movement's duration comes from the
 *     funscript itself - stash sends the upcoming points as "position:ms"
 *     pairs and this schedules them - so rampMs only applies to a point that
 *     arrives with no time left to reach it. watchdogMs is the deadman switch:
 *     nothing from stash for that long and every output drops to zero.
 *     skipSeconds is the Rewind/Forward jump.
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
var TOYS = "generic-1-a,generic-1-b,generic-1-c,generic-1-d,generic-1-e,generic-1-f,generic-1-g,generic-1-h";

var BUILD = "f914d699";             /* content hash, stamped by stamp.mjs */
var ACTION = "axes";        /* what the plugin sends on axis updates */
var RAMP_MS = 100;          /* floor for a point dispatched with no time left */
var SKIP_SECONDS = 30;      /* fallback when the skipSeconds Control is empty */
var CUSTOM_TOY_KEY = "a";   /* key a custom toy's setValue writes to */
var CONTROL_PREFIX = "out"; /* Controls out1, out2, ... hold channel names */
var INVERT_PREFIX = "inv"; /* Controls inv1, inv2, ... flip that output */
var PUMP_MS = 100;          /* how often to look for points that have come due */

var OUTS = TOYS === "" ? [] : TOYS.split(",");

/* --------------------------------------------------------------- internals */

var halted = false;
var announced = "";
var lastChannels = null;
var sendFailed = false;

/* Writes a variable so the Control displaying it redraws.
 *
 * The updateVariable Action is what the UI observes; a binding test confirmed
 * it, and confirmed Controls bind by their `id`. setVariable() also works - it
 * is readable through getVariable() - but nothing here needs reading back, so
 * the Action alone keeps one mechanism instead of two.
 *
 * If a Control stays blank, check a status message actually arrived: these are
 * only written from onStatus, and no status means nothing to show. */
function setUiVariable(name, value) {
  try {
    callAction({ type: "updateVariable", variable: name, value: String(value) });
  } catch (e) {
    console.log("could not set " + name + ": " + e);
  }
}

function numVar(name, fallback) {
  var v = parseFloat(getVariable(name));
  return isNaN(v) || v < 0 ? fallback : v;
}

/* Read live so editing a Control takes effect without reloading the script.
 * Reads the Control whose id is out1, out2, ... - not its label. */
function channelFor(i) {
  var v = getVariable(CONTROL_PREFIX + (i + 1));
  if (v === undefined || v === null) return "";
  return String(v);
}

/* Read the same way press() reads a push Control, because what a Toggle puts in
 * its variable is not documented and has not been seen in an export: anything
 * that is not clearly off counts as on. That also means it does not matter
 * whether inv1..inv8 end up as Toggles or as text inputs holding 1 - both work,
 * which is worth having while the Control type is unconfirmed. */
function isOn(name) {
  var v = getVariable(name);
  if (v === undefined || v === null) return false;
  var t = String(v);
  return t !== "" && t !== "0" && t !== "false" && t !== "off" && t !== "no";
}

function invertedFor(i) {
  return isOn(INVERT_PREFIX + (i + 1));
}

/* Toy types do not share one interface: a generic toy takes setVolume with a
 * percentVolume, a custom toy takes setValue with a key. */
function driveToy(toy, percent, seconds) {
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
    /* The schedule supplies this. rampMs is only the floor, for a point that
     * lands with no time left - without it a late dispatch would step. */
    rampTime: Math.max(seconds, numVar("rampMs", RAMP_MS) / 1000),
    percentVolume: String(percent)
  });
}

function rampOutput(toy, percent, seconds) {
  if (!toy) return;
  try {
    driveToy(toy, percent, seconds);
  } catch (e) {
    console.log("could not drive '" + toy + "': " + e +
                " - check it against the channels in your Script Export");
  }
}

function stopAll() {
  for (var i = 0; i < OUTS.length; i++) {
    rampOutput(OUTS[i], 0, 0);
  }
  clearSchedule();
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

/* XToys merges trigger data rather than replacing it: a status message still
 * carries the previous axes message's keys, and trigger-event=join persists for
 * the whole session. So a channel the current scene does not have keeps its
 * value from the last scene that did, and would go on driving an output.
 *
 * status publishes the channel list, so only honour channels that are in it. */
function sceneHasChannel(name) {
  if (lastChannels === null || lastChannels === "") return true; /* not known yet */
  return ("," + lastChannels + ",").indexOf("," + name + ",") !== -1;
}

/* ---------------------------------------------------------------- schedule */

/* The plugin sends the upcoming funscript points per channel as
 *
 *     "50:0,100:340,0:500"
 *
 * meaning: be at 50 now, reach 100 in 340ms, then 0 in a further 500ms. The
 * ramp does the rendering - setVolume was measured to retarget mid-flight, so
 * a new schedule landing on a moving toy turns it round rather than jolting it.
 *
 * Durations arrive already divided by the playback rate, so nothing here does
 * arithmetic about tempo.
 *
 * Parallel arrays rather than an array of objects: a nested structure inside a
 * closure has misbehaved in this interpreter before, and these are indexed by
 * output, which is a small fixed count. */
var dueAt = [];    /* when this output should have reached its target */
var restOf = [];   /* the schedule still to be dispatched, encoded */

/* Scratch for takeItem, which cannot return a pair. */
var itemPos = 0;
var itemDt = 0;
var itemRest = "";

function takeItem(encoded) {
  itemPos = -1;
  itemDt = 0;
  itemRest = "";
  if (!encoded || encoded === "" || encoded === "-") return false;

  var comma = encoded.indexOf(",");
  var head = comma === -1 ? encoded : encoded.substring(0, comma);
  itemRest = comma === -1 ? "" : encoded.substring(comma + 1);

  var colon = head.indexOf(":");
  if (colon === -1) return false;

  var p = parseFloat(head.substring(0, colon));
  var d = parseFloat(head.substring(colon + 1));
  if (isNaN(p)) return false;
  if (isNaN(d) || d < 0) d = 0;

  if (p < 0) p = 0;
  if (p > 100) p = 100;
  itemPos = Math.round(p);
  itemDt = d;
  return true;
}

/* Ramp toward the item, over whatever is left of its slot. A late dispatch
 * shortens the ramp instead of shifting it, so the point is still reached when
 * the funscript says - error stays inside one segment rather than accumulating
 * down the chain. */
function dispatch(i, deadline) {
  var remaining = deadline - Date.now();
  if (remaining < 0) remaining = 0;

  /* Flipped here rather than where the schedule is parsed, so it is read live -
   * ticking the box mid-scene takes effect on the next point, with no reload.
   * Only funscript positions are flipped. The zero that stopAll() and the
   * Watchdog drive is a safety floor, not a position, and inverting it would
   * turn a stop into a toy at full. */
  var pos = invertedFor(i) ? 100 - itemPos : itemPos;
  rampOutput(OUTS[i], pos, remaining / 1000);
  dueAt[i] = deadline;
  restOf[i] = itemRest;
}

function onAxes(data) {
  if (halted) return;
  var now = Date.now();

  for (var i = 0; i < OUTS.length; i++) {
    var name = channelFor(i);
    if (!name || !sceneHasChannel(name)) continue;

    var encoded = data["trigger-" + name];
    if (encoded === undefined || encoded === null) continue;

    /* A schedule supersedes rather than adds to. The plugin re-emits on every
     * seek, pause and rate change, so whatever was queued for this output
     * describes a position the player has left. */
    if (!takeItem(String(encoded))) {
      restOf[i] = "";
      continue;
    }

    /* Where the new schedule starts from is what decides whether network jitter
     * is audible.
     *
     * A leading duration of 0 is the plugin saying "snap here first", which it
     * only sends on a discontinuity - a seek, a pause, a rate change. Then the
     * timeline genuinely restarts and now is the right anchor.
     *
     * Otherwise this frame continues the one before it, and anchoring on
     * arrival would drag the whole schedule by however late the message was -
     * once per frame, for good. Chaining from the deadline already running
     * keeps playback on the timeline the first frame established, so a frame
     * that arrives late is absorbed instead of accumulating. Lateness only
     * shows up as a shortened ramp, and only on the point it arrived for. */
    var anchor = now;
    if (itemDt > 0 && dueAt[i] > 0 && dueAt[i] > now - PUMP_MS) {
      anchor = dueAt[i];
    }
    dispatch(i, anchor + itemDt);
  }
}

/* Fires everything whose slot has run out. setInterval was measured at about
 * 8/s, which is granularity rather than interpreter speed - a setVolume call
 * costs 0.3ms - so this wakes coarsely and dispatches whatever is due. */
function pump() {
  if (halted) return;
  var now = Date.now();

  for (var i = 0; i < OUTS.length; i++) {
    if (!restOf[i]) continue;
    /* not there yet - the ramp is still running */
    if (now < dueAt[i]) continue;

    if (!takeItem(restOf[i])) {
      restOf[i] = "";
      continue;
    }
    /* Chain from the slot that just ended, not from now, so a late wake-up
     * does not push every later point back with it. */
    dispatch(i, dueAt[i] + itemDt);
  }
}

function clearSchedule() {
  for (var i = 0; i < OUTS.length; i++) {
    dueAt[i] = 0;
    restOf[i] = "";
  }
}

/* There is no heartbeat message any more. Status arrives every second whether
 * anything changed or not, so it is the liveness signal too - and it is what
 * feeds the Watchdog Job below.
 *
 * The Watchdog stays a Job rather than JavaScript, though no longer because
 * JavaScript has no timer: that was asserted here for a long time and is simply
 * false. timer-test.js measured setTimeout, setInterval, sleep and Date all
 * present and working. It stays because it works and moving it buys nothing.
 * Worth knowing if that changes: setInterval asked for 100ms delivers about
 * 8/s with an empty callback, so it is a scheduler, not a render clock. */

function clock(total) {
  total = Math.max(0, Math.round(total));
  var m = Math.floor(total / 60);
  var sec = total % 60;
  return m + ":" + (sec < 10 ? "0" : "") + sec;
}

/* Shown by any Control whose `id` is one of these names. The label is separate,
 * so "Channels in scene" can display the variable `Channels`. */
function onStatus(data) {
  setUiVariable("Scene", data["trigger-title"] || "");

  /* Status carries the transport, so there is no separate pause message. It
   * matters more than it used to: a buffered schedule would otherwise play on
   * for up to a whole lookahead after the video stopped. stash publishes status
   * immediately on play and pause, not just on the interval, so this lands at
   * the transition rather than up to a second late. */
  var playing = data["trigger-playing"] === "1";
  if (playing === halted) {
    halted = !playing;
    if (halted) stopAll();
  }

  setUiVariable("Playing", playing ? "playing" : "paused");

  var pos = parseFloat(data["trigger-position"]) || 0;
  var dur = parseFloat(data["trigger-duration"]) || 0;
  setUiVariable("Elapsed", clock(pos) + " / " + clock(dur));
  setUiVariable("Rate", (data["trigger-rate"] || "1") + "x");

  /* raw values, for anything doing arithmetic rather than display */
  setUiVariable("videoPosition", data["trigger-position"] || "0");
  setUiVariable("videoDuration", data["trigger-duration"] || "0");
  setUiVariable("videoPercent", dur > 0 ? Math.round((pos / dur) * 100) : 0);

  /* Written on every status message, like the four fields above, rather than
   * only when the list changes. The Watchdog Job blanks this Control when stash
   * stops sending, and a reconnect on the same scene reports the same list - so
   * a write-on-change never fired again and it stayed empty for good. The other
   * reported fields always rewrite, which is why they recovered and this did
   * not. Change detection below is still what drives the log and the zeroing. */
  var chans = data["trigger-channels"] || "";
  setUiVariable("Channels", chans);

  if (chans !== lastChannels) {
    var previous = lastChannels;
    lastChannels = chans;
    console.log("channels in this scene: " + (chans === "" ? "(none)" : chans));

    /* Zero anything the new scene cannot drive, rather than leaving it stuck at
     * whatever the last scene left it on. */
    if (previous !== null) {
      for (var i = 0; i < OUTS.length; i++) {
        if (!sceneHasChannel(channelFor(i))) rampOutput(OUTS[i], 0, 0);
      }
    }
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
  /* Logged before the call, so a silent button separates into two cases: this
   * line missing means the Control's variableChange trigger never fired, and
   * this line present with nothing on the wire means callAction was accepted
   * but XToys sent nothing - which is the outbound checkbox. */
  console.log("button: " + action);

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
    console.log("  sent '" + action + "' data='" + data + "' on " + WEBHOOK);
  } catch (e) {
    if (!sendFailed) {
      sendFailed = true;
      console.log("sending to stash failed: " + e);
    }
  }
}

/* Button handlers. Named distinctly from the message handlers above - onPause
 * previously meant both, which silently broke pause handling. */
/* A push Control goes back to off when the mouse is released, so its variable
 * changes twice per press - 1 then 0 - and a variableChange trigger fires for
 * both. Acting on each would send every command twice. Log the value so one
 * press shows how many times this fires and with what, then only act on the
 * press rather than the release. */
function press(control, action, extra) {
  var v = getVariable(control);
  console.log("control '" + control + "' changed to [" +
              (v === undefined ? "undefined" : v === null ? "null" : String(v)) + "]");

  var down = String(v);
  if (down === "0" || down === "false" || down === "") {
    console.log("  release, ignored");
    return;
  }

  send(action, extra);
}

function onPlayButton()    { press("Play", "play"); }
function onPauseButton()   { press("Pause", "pause"); }
function onRewindButton()  { press("Rewind", "skip", { seconds: -numVar("skipSeconds", SKIP_SECONDS) }); }
function onForwardButton() { press("Forward", "skip", { seconds: numVar("skipSeconds", SKIP_SECONDS) }); }

/* Sliders hold a value rather than springing back, so they always act. */
function onSeekControl()   { send("seek", { percent: numVar("Seek", 0) }); }
function onSpeedControl()  { send("rate", { percent: numVar("Speed", 43) }); }

/* ---------------------------------------------------------------- dispatch */

/* One trigger for everything, dispatched here on trigger-action.
 *
 * action: "*" is the documented catch-all. Omitting action entirely does NOT
 * mean "any" - the trigger registers without complaint and then never fires,
 * which is what made this silent for so long. Dispatching in JavaScript keeps
 * it to a single trigger that cannot double-fire. */
function onMessage(data) {
  var action = String(data["trigger-action"] || "");

  /* Log the first of each kind. The wildcard also catches XToys' own session
   * events - a join arrives before anything of ours - so announcing only the
   * very first message reported something irrelevant and then went quiet. */
  if (announced.indexOf("|" + action + "|") === -1) {
    announced = announced + "|" + action + "|";
    var body = "";
    for (var k in data) { body = body + k + "=" + data[k] + "  "; }
    console.log("first '" + action + "' message: " + body);
  }

  /* Feeds the Watchdog Job, which is the deadman switch: JavaScript has no
   * timer, so the Job counts up and this resets it on every message. If the
   * browser goes away the Job drives everything to zero. */
  setUiVariable("lastBeat", 0);

  if (action === ACTION) onAxes(data);
  else if (action === "status") onStatus(data);
}

registerTrigger({ type: "componentState", channel: WEBHOOK, action: "*" }, onMessage);

/* Measured at about 8/s asking for 100ms. That is the scheduling granularity,
 * not a limit on work: dispatch costs 0.3ms per call, so a wake-up can fire
 * every point that has come due. Points closer together than a wake-up are
 * dispatched in the same pass, which is why the ramp carries the timing rather
 * than the interval. */
try {
  setInterval(pump, PUMP_MS);
  console.log("scheduler running every " + PUMP_MS + "ms");
} catch (e) {
  console.log("setInterval unavailable, so only the first point of each " +
              "schedule will play: " + e);
}

/* The buttons are NOT wired up here. A variableChange trigger registered from
 * JavaScript never fires when a Control changes - pressing Play produced no log
 * line at all, not even the trigger firing. Block-level globalTriggers in the
 * manifest do work, so each Control has one, and its customCode calls the
 * matching function above. That is the pattern the one public XToys
 * integration uses, and the only one observed to work. */

/* ------------------------------------------------------------------ report */

function seed(name, value) {
  var v = getVariable(name);
  if (v === undefined || v === null || String(v) === "") setUiVariable(name, value);
}

seed("rampMs", RAMP_MS);
seed("skipSeconds", SKIP_SECONDS);
seed("watchdogMs", 3000);
/* 43% of the 0.25-2x range is 1x, so the slider starts at normal speed */
seed("Speed", 43);

console.log("funscript axis router build " + BUILD + ", listening on '" + WEBHOOK + "'");

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
            "Play, Pause, Rewind, Forward (push), Seek, Speed (sliders) | " +
            "skipSeconds, rampMs, watchdogMs (advanced)");

stopAll();
