/* Stamps the XToys script with a content hash and re-embeds it in the JSON.
 *
 * The console line has to answer "is this the build I just copied?". Tying it
 * to the plugin version meant bumping the plugin for XToys-only edits, which
 * made the plugin's history claim changes it never had. A hash of the file
 * itself answers the same question and is derived, so it cannot go stale.
 *
 * Run after editing xtoys/funscriptAxisRouter.js.
 */
import fs from "node:fs";
import crypto from "node:crypto";

const JS = "xtoys/funscriptAxisRouter.js";
const JSON_FILE = "xtoys/xtoys-script.json";
const ALL_TOYS =
  "generic-1-a,generic-1-b,generic-1-c,generic-1-d," +
  "generic-1-e,generic-1-f,generic-1-g,generic-1-h";

/* Covers the manifest as well as the JavaScript. Controls, Jobs and channels are
 * as much a part of the build as the code is - a manifest-only change that left
 * the hash alone would print a stamp indistinguishable from the previous build,
 * which defeats the point of having one. */
export function buildHash(src, manifest) {
  // hash with the stamp blanked, so stamping is idempotent
  const normalised = src.replace(/var BUILD = "[^"]*";/, 'var BUILD = "";');

  const shell = { ...manifest };
  delete shell.customFunctions; // it is `src`, already hashed above

  return crypto
    .createHash("sha256")
    .update(normalised)
    .update(JSON.stringify(shell))
    .digest("hex")
    .slice(0, 8);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let src = fs.readFileSync(JS, "utf8");
  const manifest = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  const hash = buildHash(src, manifest);
  src = src.replace(/var BUILD = "[^"]*";/, `var BUILD = "${hash}";`);
  fs.writeFileSync(JS, src);

  manifest.customFunctions = src.replace(
    /var TOYS = "[^"]*";/,
    `var TOYS = "${ALL_TOYS}";`
  );
  fs.writeFileSync(JSON_FILE, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`stamped build ${hash}, re-embedded in ${JSON_FILE}`);
}
