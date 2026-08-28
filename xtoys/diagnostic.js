/* Funscript Axis Router - diagnostic v5
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

/* getConnectedBlocks() is deliberately not called: it returns a native object
 * the interpreter will not marshal, so JSON.stringify on it raises "Object is
 * not pseudo" and kills the script at load. Read channel names off your Script
 * Export instead - they are in the channels: {} section.
 *
 * Set this to the channel the messages arrive on. */
var CHANNELS = "webhook-a";

/* ---------------------------------------------------------------- probing */

var n = 0;
var keyList = KEYS.split(",");
var actionList = ACTIONS.split(",");
var i;

/* does an incoming key land as a variable? */
for (i = 0; i < keyList.length; i++) {
  n = n + reg({ type: "variableChange", variable: keyList[i] });
}

var chList = CHANNELS.split(",");
for (var c2 = 0; c2 < chList.length; c2++) {
  var ch = chList[c2];
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

console.log("diagnostic v5 ready: " + n + " triggers on " + CHANNELS +
            ". Load a scene in stash now.");
