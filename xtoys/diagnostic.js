/* Funscript Axis Router - diagnostic
 *
 * Paste into the XToys JS editor, then play a scene in stash and read the XToys
 * console. Drives nothing; only reports.
 *
 * It discovers your connected blocks and then registers every trigger shape we
 * know of against every one of them, so whichever combination actually fires
 * shows up. Webhook blocks dispatch on `action`; the JS docs show other block
 * types using `eventType`, and a custom-websocket toy is undocumented - so this
 * tries all of them rather than assuming.
 *
 * ES5 only - no let/const/arrow functions.
 */

var ACTIONS = ["axes", "status", "pause", "heartbeat"];
var EVENT_TYPES = ["message", "data", "received", "value", "state"];

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

if (channels.length === 0) {
  console.log("NO CONNECTED BLOCKS - use the plug button on the script block first");
}

/* -------------------------------------------------------------- reporting */

/* Messages arrive up to ~10x a second, so report the first few of each distinct
 * trigger shape and then go quiet. */
var seen = {};
var LIMIT = 3;

function dump(label) {
  return function (data) {
    seen[label] = (seen[label] || 0) + 1;
    if (seen[label] > LIMIT) return;

    var parts = [];
    for (var k in data) {
      if (data.hasOwnProperty(k)) parts.push(k + " = " + data[k]);
    }
    console.log("FIRED  " + label + "  {" + parts.join(", ") + "}");

    if (seen[label] === LIMIT) console.log(label + ": further messages hidden");
  };
}

/* registerTrigger may reject a shape a block does not support, so each one is
 * attempted independently. */
function tryTrigger(spec, label) {
  try {
    registerTrigger(spec, dump(label));
    return true;
  } catch (e) {
    console.log("could not register " + label + ": " + e);
    return false;
  }
}

/* ---------------------------------------------------------------- probing */

var registered = 0;

for (var i = 0; i < channels.length; i++) {
  var c = channels[i];

  /* bare - does anything at all come off this channel? */
  if (tryTrigger({ type: "componentState", channel: c }, "bare " + c)) registered++;

  /* how a webhook dispatches */
  for (var a = 0; a < ACTIONS.length; a++) {
    if (tryTrigger(
      { type: "componentState", channel: c, action: ACTIONS[a] },
      "action=" + ACTIONS[a] + " on " + c
    )) registered++;
  }

  /* how the JS docs show a dice block dispatching */
  for (var e2 = 0; e2 < EVENT_TYPES.length; e2++) {
    if (tryTrigger(
      { type: "componentState", channel: c, eventType: EVENT_TYPES[e2] },
      "eventType=" + EVENT_TYPES[e2] + " on " + c
    )) registered++;
  }
}

console.log(
  "diagnostic ready: " + registered + " triggers across " +
  channels.length + " channel(s). Play a scene in stash now."
);
console.log("If nothing FIRES, this block type does not deliver messages to a " +
            "script trigger - use a Private Webhook block instead.");
