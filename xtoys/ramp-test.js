/* setVolume ramp probe - does a ramp retarget, queue, or snap?
 *
 * Paste into the XToys JS editor INSTEAD of the router script. No stash needed;
 * this drives one toy itself and sequences the phases off setTimeout, which
 * timer-test.js confirmed works.
 *
 * WATCH THE TOY (or its level in the XToys UI). The script cannot read a toy's
 * position back, so the outcome is what you see, not what it prints. The
 * console says what should be happening and when.
 *
 * Why it matters: a keyframe-streaming design sends "go to 80 over 340ms" and
 * lets the ramp render the funscript segment, instead of sampling the script at
 * 10Hz. That only works if a ramp behaves the way the design assumes when a new
 * one arrives while the previous is still running - which is every seek.
 *
 * ES5 only, and no anonymous functions - CI checks both.
 */

var TOY = "generic-1-a";    /* the output to drive - must exist in your script */
var FEED_WATCHDOG = true;   /* the Watchdog Job zeroes outputs; keep it quiet */

var t0 = Date.now();
var burstStart = 0;
var burstEnd = 0;
var burstCalls = 0;

/* ------------------------------------------------------------------ driving */

function elapsed() {
  return Math.round(Date.now() - t0);
}

function say(text) {
  console.log("[" + elapsed() + "ms] " + text);
}

function ramp(percent, seconds) {
  try {
    callAction({
      type: "updateComponent",
      channel: TOY,
      action: "setVolume",
      rampTime: seconds,
      percentVolume: String(percent)
    });
  } catch (e) {
    console.log("could not drive '" + TOY + "': " + e);
  }
}

/* The Watchdog Job drives every output to zero once lastBeat passes watchdogMs,
 * and nothing here resets it the way the router does on each message. Left
 * alone it would fight every phase below. */
function feedWatchdog() {
  if (!FEED_WATCHDOG) return;
  try {
    callAction({ type: "updateVariable", variable: "lastBeat", value: "0" });
  } catch (e) {
    /* no Watchdog in this script, which is fine */
  }
}

/* ------------------------------------------------------------------- phases */

/* A: does rampTime mean what it says? */
function phaseA() {
  say("A: ramp 0 -> 100 over 5s. WATCH: does it glide, and take about 5s?");
  ramp(100, 5);
}

/* B: the one that decides the design. A new ramp arrives with the previous one
 * still mid-flight, which is what a seek looks like. */
function phaseB() {
  say("B: 2.5s in, so it should be near 50. Now asking for 0 over 2s.");
  say("   WATCH which of these happens:");
  say("     reverses smoothly from about half  -> RETARGETS (design works)");
  say("     carries on up to 100, then goes 0  -> QUEUES (seeks lag by a ramp)");
  say("     jumps somewhere, then moves        -> SNAPS (visible jolt per seek)");
  ramp(0, 2);
}

/* C: is a very short ramp honoured, or is there a floor? */
function phaseC() {
  say("C: three 150ms ramps, 400ms apart: 80, 20, 80.");
  say("   WATCH: three distinct moves, or smeared into one?");
  ramp(80, 0.15);
  setTimeout(phaseC2, 400);
}

function phaseC2() {
  ramp(20, 0.15);
  setTimeout(phaseC3, 400);
}

function phaseC3() {
  ramp(80, 0.15);
}

/* D: what does a callAction actually cost? This is the ceiling on how many
 * keyframes per second the XToys side could ever dispatch, whatever the timer
 * says it can do. */
function phaseD() {
  say("D: timing 20 back-to-back setVolume calls.");
  burstStart = Date.now();
  var i;
  for (i = 0; i < 20; i++) {
    ramp(i % 2 === 0 ? 40 : 60, 0.05);
    burstCalls = burstCalls + 1;
  }
  burstEnd = Date.now();
}

function finish() {
  ramp(0, 0.2);

  console.log("--- ramp probe ---");

  var ms = burstEnd - burstStart;
  console.log(burstCalls + " setVolume calls took " + ms + "ms = " +
              (burstCalls > 0 ? Math.round((ms / burstCalls) * 10) / 10 : "?") +
              "ms each");
  console.log("  that is the dispatch ceiling: keyframes per second cannot");
  console.log("  exceed 1000 / that, whatever the timer manages");

  console.log("phase B is the answer that matters - retarget, queue or snap.");
  console.log("Report it back before anything is built on ramps.");
}

/* ---------------------------------------------------------------- sequencing */

setInterval(feedWatchdog, 400);

feedWatchdog();
ramp(0, 0.1);

say("ramp probe on '" + TOY + "'. Watch the toy, not the console.");

setTimeout(phaseA, 1000);
setTimeout(phaseB, 3500);
setTimeout(phaseC, 7000);
setTimeout(phaseD, 9500);
setTimeout(finish, 11000);
