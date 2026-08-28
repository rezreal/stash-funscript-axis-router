/* Control binding test
 *
 * Paste into the XToys JS editor INSTEAD of the router script, press start,
 * then read the console AND look at the Controls on screen.
 *
 * Answers three things I have been guessing at:
 *   1. does getVariable() read what a Control holds?
 *   2. does setVariable() change what a Control shows?
 *   3. does the updateVariable Action change what a Control shows?
 *
 * ES5 only.
 */

var NAMES = "Scene,Elapsed,Playing,Channels,out1,out2";
var list = NAMES.split(",");
var i;

function dump(label) {
  var s = "";
  for (i = 0; i < list.length; i++) {
    var v = getVariable(list[i]);
    s = s + list[i] + "=[" + (v === undefined ? "undefined" :
                              v === null ? "null" : String(v)) + "]  ";
  }
  console.log(label + "  " + s);
}

console.log("--- control binding test ---");
dump("1. as found:");

for (i = 0; i < list.length; i++) {
  setVariable(list[i], "SET" + i);
}
dump("2. after setVariable:");

for (i = 0; i < list.length; i++) {
  try {
    callAction({ type: "updateVariable", variable: list[i], value: "ACT" + i });
  } catch (e) {
    console.log("   updateVariable failed for " + list[i] + ": " + e);
  }
}
dump("3. after updateVariable action:");

console.log("--- now look at the Controls on screen ---");
console.log("If any shows SET0/ACT0 etc, that write path reaches the UI.");
console.log("If all are blank, Controls do not display script-set values.");
console.log("Then type HELLO into the Scene control and press start again:");
console.log("line 1 showing Scene=[HELLO] means reading works and only");
console.log("writing is broken. Scene=[undefined] means the id does not bind.");
