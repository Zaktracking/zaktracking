/*
 * zakcod.mjs
 *
 * COD orders were being refused by Shopify with:
 *
 *   invalid value for inventoryBehaviour
 *   (Expected "DECREMENT_OBLIGATORY" to be one of:
 *    BYPASS, DECREMENT_IGNORING_POLICY, DECREMENT_OBEYING_POLICY)
 *
 * Shopify retired that value. DECREMENT_IGNORING_POLICY is the right
 * replacement for this shop: stock still comes down on every order, but a
 * product whose count has drifted below zero - which happens to every
 * dropshipper - no longer turns a real customer away at the last click.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const rel = "app/lib/order-create.server.ts";
const p = join(ROOT, rel);

if (!existsSync(p)) {
  console.log(`  ${rel} not found. Are you in the project folder?`);
  process.exit(1);
}

const src = readFileSync(p, "utf8");
const old = '"DECREMENT_OBLIGATORY"';
const now = '"DECREMENT_IGNORING_POLICY"';

if (src.includes(now)) {
  console.log("  already fixed - nothing changed");
  process.exit(0);
}
if (!src.includes(old)) {
  console.log(`  could not find the line to change in ${rel} - nothing changed`);
  process.exit(1);
}

const bak = join(ROOT, "..", "zak-bak", rel);
mkdirSync(dirname(bak), { recursive: true });
copyFileSync(p, bak);
writeFileSync(p, src.replace(old, now), "utf8");

console.log("");
console.log("written  " + rel);
console.log("backup   ..\\zak-bak");
console.log("");
console.log("Next, one command at a time:");
console.log("  npm run build");
console.log("  git add -A");
console.log('  git commit -m "shopify retired DECREMENT_OBLIGATORY; cod orders were failing on it"');
console.log("  git push");
console.log("");
