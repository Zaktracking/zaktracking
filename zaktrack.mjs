/*
 * zaktrack.mjs
 *
 * Puts a "Track your order" button on four Shopify pages that the theme
 * cannot reach:
 *
 *   - the Thank you page, right after checkout
 *   - the Order status page
 *   - the Orders list inside My Account
 *   - the Profile page inside My Account
 *
 * It also teaches the tracking page one small manner: if a link arrives
 * carrying an order number but no last-4 digits, show the form with the
 * order number already filled in, instead of an error the shopper did
 * nothing to deserve.
 *
 * Run it AFTER `shopify app generate extension` has scaffolded the
 * extension folder - the uid Shopify writes in that file is the one thing
 * here that must not be invented.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = process.cwd();
const written = [];

function backup(rel) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) return;
  const dst = join(ROOT, "..", "zak-bak", rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function write(rel, body) {
  backup(rel);
  const p = join(ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
  written.push(rel);
}

/* ---------------------------------------------------------------- */
/*  1. find the extension the CLI scaffolded                         */
/* ---------------------------------------------------------------- */

const extRoot = join(ROOT, "extensions");
let dirs = [];
if (existsSync(extRoot)) {
  dirs = readdirSync(extRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => existsSync(join(extRoot, n, "shopify.extension.toml")));
}

if (dirs.length === 0) {
  console.log("");
  console.log("  No extension found under extensions/.");
  console.log("  Run this first, then run me again:");
  console.log("");
  console.log("      npx shopify app generate extension");
  console.log("");
  process.exit(1);
}
if (dirs.length > 1) {
  console.log(`  More than one extension found (${dirs.join(", ")}). Stopping so nothing is`);
  console.log("  overwritten by accident.");
  process.exit(1);
}

const EXT = dirs[0];
const tomlRel = `extensions/${EXT}/shopify.extension.toml`;
const toml = readFileSync(join(ROOT, tomlRel), "utf8");

/* The uid is Shopify's, not ours. Carry it across untouched. */
const uid = (toml.match(/^\s*uid\s*=\s*"([^"]+)"/m) || [])[1];
const handle = (toml.match(/^\s*handle\s*=\s*"([^"]+)"/m) || [])[1] || EXT;

if (!uid) {
  console.log(`  ${tomlRel} has no uid line. That file did not come from the CLI.`);
  console.log("  Delete the folder, run `npx shopify app generate extension`, then run me again.");
  process.exit(1);
}

/* ---------------------------------------------------------------- */
/*  2. the extension                                                 */
/* ---------------------------------------------------------------- */

write(tomlRel, `api_version = "2026-07"

[[extensions]]
type   = "ui_extension"
name   = "Track your order"
handle = "${handle}"
uid    = "${uid}"

  # Right after checkout.
  [[extensions.targeting]]
  target = "purchase.thank-you.block.render"
  module = "./src/ThankYouBlock.jsx"

  # The page a shopper lands on later from the confirmation email.
  [[extensions.targeting]]
  target = "customer-account.order-status.block.render"
  module = "./src/OrderStatusBlock.jsx"

  # The list of orders inside My Account.
  [[extensions.targeting]]
  target = "customer-account.order-index.block.render"
  module = "./src/OrderIndexBlock.jsx"

  # The profile page inside My Account.
  [[extensions.targeting]]
  target = "customer-account.profile.block.render"
  module = "./src/ProfileBlock.jsx"

  # The orders list and the profile page are the two places Shopify does not
  # hand the extension the shop's own address, so it is asked for once here
  # and typed into the checkout editor.
  [extensions.settings]

    [[extensions.settings.fields]]
    key         = "tracking_url"
    type        = "single_line_text_field"
    name        = "Tracking page address"
    description = "The full address of your tracking page, for example https://zakdor.com/apps/track"
`);

write(`extensions/${EXT}/package.json`, JSON.stringify({
  name: handle,
  private: true,
  dependencies: {
    "@shopify/ui-extensions": "2026.7.x",
    preact: "^10.10.0",
  },
}, null, 2) + "\n");

write(`extensions/${EXT}/tsconfig.json`, JSON.stringify({
  compilerOptions: {
    jsx: "react-jsx",
    jsxImportSource: "preact",
    target: "ES2020",
    checkJs: false,
    allowJs: true,
    moduleResolution: "node",
    esModuleInterop: true,
  },
  include: ["./src", "./shopify.d.ts"],
}, null, 2) + "\n");

/* The shop's own domain, however Shopify chooses to hand it over.
   storefrontUrl is the branded one; the myshopify address is the one that
   never changes. Prefer the first, fall back to the second. */
const BASE = `function storeBase() {
  var s = typeof shopify !== "undefined" ? shopify.shop : null;
  if (!s) return "";
  if (s.storefrontUrl) return String(s.storefrontUrl).replace(/\\/+$/, "");
  if (s.myshopifyDomain) return "https://" + s.myshopifyDomain;
  return "";
}`;

write(`extensions/${EXT}/src/ThankYouBlock.jsx`, `import "@shopify/ui-extensions/preact";
import { render } from "preact";

/* Thank you page. The order does not exist yet at this moment, so there is
   nothing to look up - just the way to the tracking page. */

export default function () {
  render(<Extension />, document.body);
}

${BASE}

function Extension() {
  const base = storeBase();
  if (!base) return null;

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>
          Follow your parcel from our warehouse to your door. You will need your
          order number and the last 4 digits of your phone number.
        </s-text>
        <s-button href={base + "/apps/track"} variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
`);

write(`extensions/${EXT}/src/OrderStatusBlock.jsx`, `import "@shopify/ui-extensions/preact";
import { render } from "preact";

/* Order status page. Here the order is real, so the order number travels
   in the link and the shopper only has to add the last 4 digits. */

export default function () {
  render(<Extension />, document.body);
}

${BASE}

function Extension() {
  const base = storeBase();
  if (!base) return null;

  const order = shopify.order ? shopify.order.value : null;
  let href = base + "/apps/track";
  if (order && order.name) {
    href += "?order=" + encodeURIComponent(order.name);
  }

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>See where your parcel has reached right now.</s-text>
        <s-button href={href} target="_blank" variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
`);

/* The orders list and the profile page get no order and no shop from
   Shopify, so both read the address the merchant typed once. */
const SETTINGS_BLOCK = (line) => `import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default function () {
  render(<Extension />, document.body);
}

function Extension() {
  const s = typeof shopify !== "undefined" && shopify.settings ? shopify.settings.value : null;
  const href = s && s.tracking_url ? String(s.tracking_url).trim() : "";
  if (!href) return null;

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>${line}</s-text>
        <s-button href={href} target="_blank" variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
`;

write(`extensions/${EXT}/src/OrderIndexBlock.jsx`, SETTINGS_BLOCK(
  "Check where any of your parcels have reached."));
write(`extensions/${EXT}/src/ProfileBlock.jsx`, SETTINGS_BLOCK(
  "Looking for a parcel? Track any of your orders here."));

/* ---------------------------------------------------------------- */
/*  3. the tracking page: an order number on its own is not an error */
/* ---------------------------------------------------------------- */

const pageRel = "app/routes/proxy.track._index.tsx";
const pagePath = join(ROOT, pageRel);
if (!existsSync(pagePath)) {
  console.log(`  ${pageRel} not found. Extension written, tracking page left alone.`);
} else {
  const src = readFileSync(pagePath, "utf8");
  const old = "  if (!num && !orderQ) return liquid(page(blank));";
  const now =
    "  // An order number with no last-4 yet is a link doing its job, not a\n" +
    "  // mistake. Show the form with the number already in it.\n" +
    "  if ((!num && !orderQ) || (orderQ && !pin)) {\n" +
    "    return liquid(page({ ...blank, order: orderQ, pin }));\n" +
    "  }";

  if (src.includes(now)) {
    console.log("  tracking page already carries the prefill - left as it is");
  } else if (!src.includes(old)) {
    console.log(`  could not find the line to change in ${pageRel} - left it alone`);
  } else {
    write(pageRel, src.replace(old, now));
  }
}

/* ---------------------------------------------------------------- */

console.log("");
for (const f of written) console.log("written  " + f);
console.log("backup   ..\\zak-bak");
console.log("");
console.log("Next, one command at a time:");
console.log("  npm install");
console.log("  npm run build");
console.log("  npx shopify app deploy");
console.log("");
