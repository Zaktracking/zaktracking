#!/usr/bin/env node
/* ZakTracking - the one line that has been breaking every deploy since
 * 30 August.
 *
 *   app/routes/webhooks.orders.cancelled.tsx imports "renderMessage" from
 *   app/lib/notify.server.ts, and notify.server.ts does not export it. Vite
 *   stops there, so the build never finishes and Render keeps serving the
 *   old copy.
 *
 * This removes that one name from that one import. Nothing else.
 *
 * If the file turns out to actually CALL renderMessage somewhere, the patch
 * writes nothing and says so - taking the import away would only move the
 * break from build time to the middle of a real cancellation.
 */
import fs from "node:fs";
import path from "node:path";

const FILE = "app/routes/webhooks.orders.cancelled.tsx";
const p = path.resolve(FILE);

if (!fs.existsSync(p)) {
  console.error("MISSING  " + FILE + " - is this the zaktracking repo root?");
  process.exit(1);
}

let text = fs.readFileSync(p, "utf8");

if (!text.includes("renderMessage")) {
  console.log("Already applied - the import is clean. Nothing to do.");
  process.exit(0);
}

const before = text;
text = text
  .replace(/(\{[^}]*?),\s*renderMessage\s*(,)/g, "$1$2")
  .replace(/(\{\s*)renderMessage\s*,\s*/g, "$1")
  .replace(/,\s*renderMessage(\s*\})/g, "$1");

if (text === before) {
  console.error("NO MATCH  could not find renderMessage in an import list.");
  console.error("          Nothing written. Send me the file and I will look.");
  process.exit(1);
}

if (text.includes("renderMessage")) {
  console.error("STILL USED  renderMessage appears somewhere else in the file,");
  console.error("            not just in the import. Nothing has been written.");
  console.error("            Send me the file and I will write the real fix.");
  process.exit(1);
}

fs.writeFileSync(p, text);
console.log("written  " + FILE);
console.log("");
console.log("Now run the build yourself to see it pass:");
console.log("  npm run build");
console.log("");
console.log("If it says 'built in ...' with no red, then:");
console.log("  git add -A");
console.log("  git commit -m \"fix the import that broke every build\"");
console.log("  git push");
