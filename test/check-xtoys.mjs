/* Structural checks for the XToys-side JavaScript.
 *
 * `node --check` is not enough: a function declaration in an if-body parses
 * fine, and that is exactly how a bad patch silently gutted onPause() and
 * shipped. These assert the properties that actually matter here.
 */
import fs from "node:fs";

const FILES = ["xtoys/funscriptAxisRouter.js", "xtoys/diagnostic.js"];
let failures = 0;

function fail(file, msg) {
  failures++;
  console.log(`  FAIL ${file}: ${msg}`);
}

for (const file of FILES) {
  const src = fs.readFileSync(file, "utf8");
  console.log(file);

  const names = [...src.matchAll(/^function\s+([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]);
  const seen = new Set();
  const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  if (dupes.length) fail(file, `duplicate function names: ${[...new Set(dupes)].join(", ")}`);

  // how the last corruption manifested
  if (/if\s*\([^)]*\)\s*(?:\/\*[\s\S]*?\*\/\s*)?function\s/.test(src)) {
    fail(file, "a function declaration is being used as an if-body");
  }

  // JS-Interpreter is ES5 only, and chokes on anonymous nested functions
  for (const [re, what] of [
    [/\b(?:let|const)\s+[A-Za-z_$]/, "let/const (ES5 only)"],
    [/=>/, "arrow function (ES5 only)"],
    [/`/, "template literal (ES5 only)"],
    [/function\s*\(/, "anonymous function"],
    [/\.hasOwnProperty\(/, "hasOwnProperty (unreliable under JS-Interpreter)"],
    [/getConnectedBlocks\s*\(/, "getConnectedBlocks() call (will not marshal)"],
  ]) {
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (re.test(stripped)) fail(file, `uses ${what}`);
  }

  // every registered handler must exist
  for (const m of src.matchAll(/registerTrigger\([^,]+,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    if (!names.includes(m[1])) fail(file, `registerTrigger references undefined ${m[1]}()`);
  }

  if (!failures) console.log("  ok");
}

// the manifest must carry the same JS it claims to
const manifest = JSON.parse(fs.readFileSync("xtoys/xtoys-script.json", "utf8"));
const embedded = manifest.customFunctions;
const standalone = fs.readFileSync("xtoys/funscriptAxisRouter.js", "utf8");
console.log("xtoys/xtoys-script.json");
if (!embedded || embedded.length < 1000) {
  fail("manifest", "customFunctions is missing or truncated");
} else if (manifest.globalTriggers.length > 0) {
  fail("manifest", "has block triggers as well as JS - every output would fire twice");
} else if (embedded.split("\n").length !== standalone.split("\n").length) {
  fail("manifest", "customFunctions has drifted from funscriptAxisRouter.js");
} else {
  console.log("  ok");
}

console.log(failures ? `\n${failures} failed` : "\nxtoys checks passed");
process.exit(failures ? 1 : 0);
