/* Funscript Axis Router - diagnostic v3
 *
 * Paste into the XToys JS editor, play a scene in stash, read the console.
 * Drives nothing; only reports.
 *
 * A webhook dispatches on the value of an "action" key. A custom websocket toy
 * takes plain {"vibrate": "10"} with no action at all, so its dispatch is
 * presumably keyed on the KEY name. v2 only probed action values and generic
 * eventTypes, which is why nothing fired against a custom toy. This probes the
 * key names we actually send, as variables and as trigger discriminators.
 *
 * ES5 only - no let/const/arrow functions.
 */

/* Every key the plugin can put on the wire. */
var KEYS = [
  "roll", "pitch", "stroke", "surge", "sway", "twist", "suck", "valve", "lube",
  "action", "pause", "heartbeat", "payload",
  "title", "position", "duration", "playing", "scene",
  /* common custom-toy command names, in case the toy defines its own schema */
  "vibrate", "intensity", "speed", "value", "linear", "rotate"
];

var ACTIONS = ["axes", "status", "pause", "heartbeat"];

/* ---------------------------------------------------------------- blocks */

var blocks = {};
try {
  blocks = getConnectedBlocks() || {};
  console.log("connected blocks: " + JSON.stringify(blocks));
} catch (e) {
  console.log("getConnectedBlocks() failed: " + e);
}

var channels = [];
for (var ch in blocks) {
  if (blocks.hasOwnProperty(ch)) channels.push(ch);
}

/* -------------------------------------------------------------- reporting */

var seen = {};
var LIMIT = 2;

function dump(label) {
  return function (data) {
    seen[label] = (seen[label] || 0) + 1;
    if (seen[label] > LIMIT) return;

    var parts = [];
    for (var k in data) {
      if (data.hasOwnProperty(k)) parts.push(k + " = " + data[k]);
    }
    console.log("FIRED  " + label + "  {" + parts.join(", ") + "}");
    if (seen[label] === LIMIT) console.log(label + ": further hidden");
  };
}

function tryTrigger(spec, label) {
  try {
    registerTrigger(spec, dump(label));
    return 1;
  } catch (e) {
    return 0;
  }
}

/* ---------------------------------------------------------------- probing */

var n = 0;

/* 1. does an incoming key land as an XToys variable? */
for (var k = 0; k < KEYS.length; k++) {
  n += tryTrigger({ type: "variableChange", variable: KEYS[k] }, "variable " + KEYS[k]);
}

for (var i = 0; i < channels.length; i++) {
  var c = channels[i];

  /* 2. anything at all off this channel */
  n += tryTrigger({ type: "componentState", channel: c }, "bare " + c);

  /* 3. dispatch keyed on the JSON key name - the custom-toy shape */
  for (var j = 0; j < KEYS.length; j++) {
    n += tryTrigger({ type: "componentState", channel: c, eventType: KEYS[j] },
                    "eventType=" + KEYS[j] + " on " + c);
    n += tryTrigger({ type: "componentState", channel: c, action: KEYS[j] },
                    "action=" + KEYS[j] + " on " + c);
  }

  /* 4. dispatch keyed on our action values - the webhook shape */
  for (var a = 0; a < ACTIONS.length; a++) {
    n += tryTrigger({ type: "componentState", channel: c, action: ACTIONS[a] },
                    "action=" + ACTIONS[a] + " on " + c);
  }
}

console.log("diagnostic v3 ready: " + n + " triggers, " + channels.length +
            " channel(s). Play a scene in stash now.");
console.log("Note: a custom toy may only accept the command keys it was " +
            "defined with. If only 'vibrate'-style keys fire, tell the plugin " +
            "to use those names via its Axes To Route setting.");
