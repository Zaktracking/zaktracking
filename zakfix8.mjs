/*
 * zakfix8.mjs
 *
 * Three things, all of them the reason orders were being refused.
 *
 * 1. The plus sign. toE164 returns 919608687671 because that is what
 *    WhatsApp wants. Shopify wants +919608687671 and calls anything else
 *    "Phone is invalid". Every COD order was dying on this one character.
 *
 * 2. The state. The form collects city and PIN but never a state, and an
 *    Indian address without one is half an address. The order side already
 *    knew how to store it; nothing was ever sending it.
 *
 * 3. read_discounts. Without it the app cannot read a discount code back
 *    from Shopify, so it cannot tell a real code from an invented one -
 *    which is why the prepaid saving has been behaving oddly.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const written = [];

function patch(rel, edits) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) { console.log(`  ${rel} not found - skipped`); return; }
  let s = readFileSync(p, "utf8");
  let done = 0, already = 0;

  for (const [old, now] of edits) {
    if (s.includes(now)) { already++; continue; }
    if (!s.includes(old)) { console.log(`  ${rel}: could not find a piece - nothing written`); return; }
    s = s.replace(old, now);
    done++;
  }

  if (done === 0) { console.log(`  ${rel} already done`); return; }

  const bak = join(ROOT, "..", "zak-bak", rel);
  mkdirSync(dirname(bak), { recursive: true });
  copyFileSync(p, bak);
  writeFileSync(p, s, "utf8");
  written.push(rel);
}

/* ------------------------------------------------------------------ */

patch("app/lib/order-create.server.ts", [
  [
`  const order: any = {
    email: b.email || null,
    phone: b.phone,`,
`  // Shopify wants the plus sign; WhatsApp does not, and toE164 is shared
  // with it. So the sign goes back on here rather than there.
  const e164 = b.phone.charAt(0) === "+" ? b.phone : "+" + b.phone.replace(/\\D/g, "");

  const order: any = {
    email: b.email || null,
    phone: e164,`,
  ],
  [
`      countryCode: "IN",
      phone: b.phone,`,
`      countryCode: "IN",
      phone: e164,`,
  ],
]);

patch("app/routes/proxy.track.buy.tsx", [
  [
`  const zip = String(d.zip ?? "").replace(/\\D/g, "");`,
`  const zip = String(d.zip ?? "").replace(/\\D/g, "");
  // Two letters, the way Shopify writes an Indian state: BR, MH, DL.
  const province = String(d.province ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2) || null;`,
  ],
  [
`    city: String(d.city).trim().slice(0, 60),
    zip,`,
`    city: String(d.city).trim().slice(0, 60),
    province,
    zip,`,
  ],
]);

patch("shopify.app.toml", [
  [
`# read_products     -> product title and image inside messages and on the page`,
`# read_products     -> product title and image inside messages and on the page
# read_discounts    -> check a discount code is real before it reaches an order`,
  ],
  [
`scopes = "read_orders,write_orders,read_checkouts,read_fulfillments,read_customers,read_products,write_app_proxy"`,
`scopes = "read_orders,write_orders,read_checkouts,read_fulfillments,read_customers,read_products,read_discounts,write_app_proxy"`,
  ],
]);

/* ------------------------------------------------------------------ */

console.log("");
for (const f of written) console.log("written  " + f);
if (!written.length) console.log("  nothing to change");
console.log("backup   ..\\zak-bak");
console.log("");
console.log("Next, one command at a time:");
console.log("  npm run build");
console.log("  git add -A");
console.log('  git commit -m "the plus sign shopify wanted, the state the address was missing, and permission to read a discount"');
console.log("  git push");
console.log("  npx shopify app deploy");
console.log("");
