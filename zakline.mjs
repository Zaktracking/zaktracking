/*
 * zakline.mjs
 *
 * One line is enough on the Thank you page. The shopper has just paid;
 * telling them what they will be asked for on the next page is a chore
 * they did not ask for.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const extRoot = join(ROOT, "extensions");

const dirs = existsSync(extRoot)
  ? readdirSync(extRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => existsSync(join(extRoot, n, "src", "ThankYouBlock.jsx")))
  : [];

if (dirs.length !== 1) {
  console.log("  Could not find the extension. Nothing changed.");
  process.exit(1);
}

const rel = `extensions/${dirs[0]}/src/ThankYouBlock.jsx`;
const p = join(ROOT, rel);
const src = readFileSync(p, "utf8");

const line = "        <s-text>Follow your parcel from our warehouse to your door.</s-text>";

if (src.includes(line)) {
  console.log("  already the short version - nothing changed");
  process.exit(0);
}

const out = src.replace(/^ *<s-text>[\s\S]*?<\/s-text>$/m, line);

if (out === src) {
  console.log(`  could not find the sentence in ${rel} - nothing changed`);
  process.exit(1);
}

const bak = join(ROOT, "..", "zak-bak", rel);
mkdirSync(dirname(bak), { recursive: true });
copyFileSync(p, bak);
writeFileSync(p, out, "utf8");

console.log("");
console.log("written  " + rel);
console.log("backup   ..\\zak-bak");
console.log("");
console.log("Next, one command at a time:");
console.log("  npx shopify app deploy");
console.log("  git add -A");
console.log('  git commit -m "one line is enough on the thank you page"');
console.log("  git push");
console.log("");
