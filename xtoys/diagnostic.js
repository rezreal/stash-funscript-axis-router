/* Funscript Axis Router - diagnostic v4
 *
 * Paste into the XToys JS editor, load a scene in stash, read the console.
 * Drives nothing; only reports.
 *
 * Written defensively for JS-Interpreter, which is not a full ES5 engine:
 *   - no closures. registerTrigger passes the original trigger JSON as its
 *     second argument, so one top-level callback can tell which shape fired.
 *   - no arrays or array methods; strings are built by concatenation.
 *   - no hasOwnProperty.
 * v3 used a closure factory with a local array and threw
 * "can't access property push of undefined" on every single message.
 */

var KEYS = "roll,pitch,stroke,surge,sway,twist,suck,valve,lube," +
           "action,pause,heartbeat,payload," +
           "title,position,duration,playing,scene," +
           "vibrate,intensity,speed,value,linear,rotate";

var ACTIONS = "axes,status,pause,heartbeat";

var fired = 0;
var MAX_REPORTS = 30;

/* One callback for everything. `spec` is the trigger JSON that fired. */
function onFire(data, spec) {
  fired = fired + 1;
  if (fired > MAX_REPORTS) return;

  var body = "";
  for (var k in data) {
    body = body + k + "=" + data[k] + "  ";
  }

  var which = "";
  try {
    which = JSON.stringify(spec);
  } catch (e) {
    which = "?";
  }

  console.log("FIRED " + which + "  ::  " + body);
  if (fired === MAX_REPORTS) {
    console.log("(further reports suppressed)");
  }
}

function reg(spec) {
  try {
    registerTrigger(spec, onFire);
    return 1;
  } catch (e) {
    return 0;
  }
}

/* ---------------------------------------------------------------- blocks */

var blocks = {};
try {
  blocks = getConnectedBlocks();
  console.log("connected blocks: " + JSON.stringify(blocks));
} catch (e) {
  console.log("getConnectedBlocks() failed: " + e);
}

/* ---------------------------------------------------------------- probing */

var n = 0;
var keyList = KEYS.split(",");
var actionList = ACTIONS.split(",");
var i;

/* does an incoming key land as a variable? */
for (i = 0; i < keyList.length; i++) {
  n = n + reg({ type: "variableChange", variable: keyList[i] });
}

for (var ch in blocks) {
  n = n + reg({ type: "componentState", channel: ch });

  /* webhook shape: dispatch on the action value */
  for (i = 0; i < actionList.length; i++) {
    n = n + reg({ type: "componentState", channel: ch, action: actionList[i] });
  }

  /* custom-toy shape: dispatch on the key name itself */
  for (i = 0; i < keyList.length; i++) {
    n = n + reg({ type: "componentState", channel: ch, eventType: keyList[i] });
    n = n + reg({ type: "componentState", channel: ch, action: keyList[i] });
  }
}

console.log("diagnostic v4 ready: " + n + " triggers. Load a scene in stash now.");
