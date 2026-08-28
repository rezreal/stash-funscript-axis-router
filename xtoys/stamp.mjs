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

export function buildHash(src) {
  // hash with the stamp blanked, so stamping is idempotent
  const normalised = src.replace(/var BUILD = "[^"]*";/, 'var BUILD = "";');
  return crypto.createHash("sha256").update(normalised).digest("hex").slice(0, 8);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let src = fs.readFileSync(JS, "utf8");
  const hash = buildHash(src);
  src = src.replace(/var BUILD = "[^"]*";/, `var BUILD = "${hash}";`);
  fs.writeFileSync(JS, src);

  const manifest = JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  manifest.customFunctions = src.replace(
    /var TOYS = "[^"]*";/,
    `var TOYS = "${ALL_TOYS}";`
  );
  fs.writeFileSync(JSON_FILE, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`stamped build ${hash}, re-embedded in ${JSON_FILE}`);
}
