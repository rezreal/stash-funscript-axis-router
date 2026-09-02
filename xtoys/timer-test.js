/* Timer probe - what timing facilities does the XToys JS editor actually have?
 *
 * Paste into the XToys JS editor INSTEAD of the router script, with stash
 * connected and playing. Its heartbeat is the clock this borrows, so the
 * blocking test needs messages arriving. Then read the console.
 *
 * Why: the router drives everything from incoming messages and puts its
 * deadman switch in a Job, because "JavaScript here has no timer". That was
 * asserted early and carried through a rewrite, but never tested - unlike the
 * custom-toy-as-input finding next to it, which says how it was ruled out.
 *
 * The XToys JS docs do list sleep(ms), and a Timer Action that callAction can
 * block on. What they do not say is whether blocking stalls only the calling
 * function or the whole script. That is the question worth money: if triggers
 * still fire during a sleep, the XToys side can run a render loop and play a
 * funscript segment itself, instead of being fed samples ten times a second.
 *
 * ES5 only, and no anonymous functions - CI checks both.
 */

var WEBHOOK = "webhook-a";  /* the channel the router listens on */
var SLEEP_MS = 2000;        /* long enough to span several stash heartbeats */
var TEST_AT = 3;            /* run the blocking test on this message */
var REPORT_AT = 8;          /* report once this many have arrived */

var messages = 0;
var firstDate = null;
var lastDate = null;

var timeoutFired = 0;
var intervalFired = 0;

var sleepBefore = -1;
var sleepAfter = -1;
var sleepTicksBefore = -1;
var sleepTicksAfter = -1;
var sleepDate = -1;
var sleepError = "";
var sleepDone = false;
var reported = false;

/* -------------------------------------------------------------- what exists */

/* typeof on an undeclared name is safe in real ES5, but this is not a real ES5
 * engine, so every probe is wrapped rather than trusted. */
var exists = "";

function note(name, kind) {
  exists = exists + "  " + name + ": " + kind + "\n";
}

try { note("setTimeout", typeof setTimeout); } catch (e1) { note("setTimeout", "threw " + e1); }
try { note("setInterval", typeof setInterval); } catch (e2) { note("setInterval", "threw " + e2); }
try { note("sleep", typeof sleep); } catch (e3) { note("sleep", "threw " + e3); }
try { note("Date", typeof Date); } catch (e4) { note("Date", "threw " + e4); }
try { note("performance", typeof performance); } catch (e5) { note("performance", "threw " + e5); }
try { note("requestAnimationFrame", typeof requestAnimationFrame); } catch (e6) { note("requestAnimationFrame", "threw " + e6); }
try { note("Promise", typeof Promise); } catch (e7) { note("Promise", "threw " + e7); }
try { note("callAction", typeof callAction); } catch (e8) { note("callAction", "threw " + e8); }
try { note("registerTrigger", typeof registerTrigger); } catch (e9) { note("registerTrigger", "threw " + e9); }
try { note("getVariable", typeof getVariable); } catch (e10) { note("getVariable", "threw " + e10); }
try { note("getXhr", typeof getXhr); } catch (e11) { note("getXhr", "threw " + e11); }
/* Cancellation decides how a buffered design handles a seek: with it, drop the
 * pending timers; without it, every scheduled item has to carry a generation
 * counter and no-op when a newer emit has superseded it. */
try { note("clearTimeout", typeof clearTimeout); } catch (e20) { note("clearTimeout", "threw " + e20); }
try { note("clearInterval", typeof clearInterval); } catch (e21) { note("clearInterval", "threw " + e21); }

/* ------------------------------------------------------------- do they fire */

/* Existing is not the same as working. If either of these is callable, the
 * counters below say whether the callback ever actually ran. */
function onTimeoutFired() {
  timeoutFired = timeoutFired + 1;
  console.log("setTimeout callback FIRED");
}

function onIntervalFired() {
  intervalFired = intervalFired + 1;
  /* Say so on the first one. Counting silently meant setInterval looked
   * identical whether it fired or not until the readout, which needs a scene
   * playing - so a run without stash said nothing about the more useful of the
   * two timers. */
  if (intervalFired === 1) {
    console.log("setInterval callback FIRED (first of many, counting now)");
  }

  /* Report from inside the loop rather than from the message handler. The
   * readout below borrows stash's heartbeat as a clock, which was the right
   * shape only while a local clock was assumed not to exist - Date does exist,
   * so the number that decides everything can be had with nothing connected. */
  if (intervalFired % 50 === 0 && firstDate !== null) {
    var secs = (Date.now() - firstDate) / 1000;
    if (secs > 0) {
      console.log("setInterval: " + intervalFired + " fires in " +
                  Math.round(secs) + "s = " +
                  Math.round((intervalFired / secs) * 10) / 10 +
                  "/s (asked for 10/s)");
    }
  }
}

try { firstDate = Date.now(); } catch (e14) { firstDate = null; }

try {
  setTimeout(onTimeoutFired, 500);
  console.log("setTimeout accepted a callback");
} catch (e12) {
  console.log("setTimeout unusable: " + e12);
}

try {
  setInterval(onIntervalFired, 100);
  console.log("setInterval accepted a callback");
} catch (e13) {
  console.log("setInterval unusable: " + e13);
}

/* --------------------------------------------------------- the real question */

/* Sleep while messages are arriving, then see whether any landed in the gap.
 *
 *   count moved during the sleep  -> triggers still fire, the interpreter
 *                                    blocks only this function, and a render
 *                                    loop on the XToys side is possible
 *   count unchanged, then a burst -> callbacks queued behind the sleep; still
 *                                    workable, but a loop would add latency
 *                                    equal to its own period
 *   count unchanged, no burst     -> messages were dropped, and blocking is
 *                                    not usable at all
 */
function testBlocking() {
  sleepDone = true;
  sleepBefore = messages;
  /* The decisive one. If the interval keeps ticking through the sleep, only
   * this function is blocked; if it stops too, the whole interpreter stalls and
   * nothing else in the script runs either. */
  sleepTicksBefore = intervalFired;
  try {
    sleep(SLEEP_MS);
    sleepAfter = messages;
    sleepTicksAfter = intervalFired;
    try { sleepDate = Date.now() - firstDate; } catch (e15) { sleepDate = -1; }
  } catch (e16) {
    sleepError = String(e16);
  }
}

/* The Timer Action is the other documented way to wait. The Action's own shape
 * is not documented for callAction, so this reports what it says rather than
 * assuming a shape that works - an error naming the expected fields is itself
 * the answer. */
function testTimerAction() {
  try {
    callAction({ type: "timer", amount: 1 }, true);
    console.log("timer Action with block=true returned");
  } catch (e17) {
    console.log("timer Action rejected: " + e17);
  }
}

/* ------------------------------------------------------------------ readout */

function report() {
  reported = true;

  console.log("--- timer probe ---");
  console.log("globals:\n" + exists);

  console.log("setTimeout callback fired " + timeoutFired + " time(s)");
  console.log("setInterval callback fired " + intervalFired + " time(s)");
  console.log("  (both zero with the globals present means they are stubs)");

  /* The whole architecture question in one number. Asked for 100ms, so 10/s is
   * the ceiling; what it actually sustains through the interpreter is what says
   * whether the XToys side can render a funscript segment. */
  if (firstDate !== null && lastDate !== null && lastDate > firstDate) {
    var seconds = (lastDate - firstDate) / 1000;
    console.log("setInterval asked for 100ms; achieved " +
                Math.round((intervalFired / seconds) * 10) / 10 + "/s over " +
                Math.round(seconds) + "s (10/s is the ceiling here)");
  }

  if (firstDate === null) {
    console.log("Date.now() unavailable - no clock, so lateness cannot be measured");
  } else {
    console.log("Date.now() advanced " + (lastDate - firstDate) + "ms over " +
                messages + " messages - a clock exists");
  }

  if (sleepError !== "") {
    console.log("sleep() threw: " + sleepError);
  } else if (!sleepDone) {
    console.log("sleep() never ran - fewer than " + TEST_AT + " messages arrived");
  } else {
    console.log("sleep(" + SLEEP_MS + ") spanned messages " + sleepBefore +
                " -> " + sleepAfter + " (" + (sleepAfter - sleepBefore) + " arrived during it)");
    if (sleepDate >= 0) {
      console.log("  and " + sleepDate + "ms on the clock since load");
    }
    console.log("setInterval ticked " + (sleepTicksAfter - sleepTicksBefore) +
                " time(s) during that sleep (about " +
                Math.round(SLEEP_MS / 100) + " if it kept running)");
    console.log("  ticks kept coming = sleep blocks only the calling function");
    console.log("  ticks stopped too = the whole interpreter stalls");
    console.log("  moved  = triggers fire during a sleep, a render loop is possible");
    console.log("  0 then a burst = callbacks queue behind it, loop costs its own period in latency");
    console.log("  0 and no burst = messages dropped, blocking is unusable");
  }

  if (scriptTicks === 0) {
    console.log("scriptState timer never fired - registered silently, like");
    console.log("  variableChange does from JavaScript. Manifest-level only.");
  } else if (scriptFirstTick !== null && lastDate > scriptFirstTick) {
    console.log("scriptState timer fired " + scriptTicks + " time(s), " +
                Math.round((scriptTicks / ((lastDate - scriptFirstTick) / 1000)) * 10) / 10 +
                "/s (asked for 1/s)");
  } else {
    console.log("scriptState timer fired " + scriptTicks + " time(s)");
  }

  console.log("--- now check the Job timer, which is the other half ---");
  console.log("Set the Watchdog Job's timer amount to 0.02 and have it call");
  console.log("jobTick(); as a customCode action. 10s should give ~500 ticks;");
  console.log("far fewer means XToys-native scheduling is too slow to render on.");
}

/* A scriptState timer trigger - XToys-native, so it does not compete with the
 * interpreter for time the way setInterval does. Documented lower bound is 1s,
 * which is slower than both setInterval (~8/s measured) and the Watchdog Job
 * (0.5s), so this is about dependability rather than rate.
 *
 * Registering is not firing. cd6c681 found a variableChange trigger registered
 * from JavaScript registers without complaint and then never fires, while
 * componentState from JavaScript works - so the type matters and the failure
 * mode is silence. Hence a counter rather than a hopeful log line. */
var scriptTicks = 0;
var scriptFirstTick = null;

function onScriptTimer() {
  scriptTicks = scriptTicks + 1;
  if (scriptTicks === 1) {
    console.log("scriptState timer trigger FIRED - it works from JavaScript");
    try { scriptFirstTick = Date.now(); } catch (eS) { scriptFirstTick = null; }
  }
}

try {
  registerTrigger({ type: "scriptState", part: "timer", amount: "1" }, onScriptTimer);
  console.log("scriptState timer trigger registered (firing is a separate question)");
} catch (e19) {
  console.log("scriptState timer trigger rejected: " + e19);
}

/* Call this from a Job timer's customCode to measure the achievable tick rate. */
var jobTicks = 0;

function jobTick() {
  jobTicks = jobTicks + 1;
  if (jobTicks % 50 === 0) {
    console.log("job ticks: " + jobTicks);
  }
}

/* ----------------------------------------------------------------- dispatch */

function onMessage(data) {
  messages = messages + 1;
  try { lastDate = Date.now(); } catch (e18) { lastDate = null; }

  if (messages === TEST_AT && !sleepDone) {
    testBlocking();
    testTimerAction();
  }

  if (messages === REPORT_AT && !reported) {
    report();
  }
}

registerTrigger({ type: "componentState", channel: WEBHOOK, action: "*" }, onMessage);

console.log("timer probe ready on '" + WEBHOOK + "'. Play a scene in stash;");
console.log("the readout lands after " + REPORT_AT + " messages.");
console.log("globals at load:\n" + exists);
