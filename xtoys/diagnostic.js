/* Funscript Axis Router - diagnostic
 *
 * Paste this into the XToys JS editor (JS button in the toolbar) INSTEAD of
 * funscriptAxisRouter.js, press play on a scene in stash, and read the XToys
 * console. It drives nothing - it only reports what arrives, so we can see the
 * real shapes before wiring up outputs.
 *
 * Three things it answers:
 *   1. what your blocks are actually called (channel names for OUTPUTS)
 *   2. whether the triggers fire at all
 *   3. the exact trigger-<key> data each message carries
 *
 * ES5 only - no let/const/arrow functions.
 */

/* If the plugin's messages never show up, this is the first thing to check:
 * it must match the channel name of the block receiving them. */
var WEBHOOK = "webhook-a";

/* ---------------------------------------------------------------- blocks */

try {
  var blocks = getConnectedBlocks();
  console.log("connected blocks: " + JSON.stringify(blocks));
} catch (e) {
  console.log("getConnectedBlocks() failed: " + e);
}

/* -------------------------------------------------------------- messages */

/* axes arrive ~10x a second and heartbeats every second, so this reports the
 * first few of each and then goes quiet rather than flooding the console. */
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
    console.log(label + " #" + seen[label] + "  {" + parts.join(", ") + "}");

    if (seen[label] === LIMIT) {
      console.log(label + ": further messages hidden");
    }
  };
}

registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "axes" }, dump("axes"));
registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "status" }, dump("status"));
registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "pause" }, dump("pause"));
registerTrigger(
  { type: "componentState", channel: WEBHOOK, action: "heartbeat" }, dump("heartbeat"));

console.log("diagnostic ready; listening on channel '" + WEBHOOK + "'");
