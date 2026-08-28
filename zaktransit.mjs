#!/usr/bin/env node
// ZakTracking - give "in transit" its own switch, off by default.
// Run with:  node zaktransit.mjs
//
// Patches your existing files - nothing is replaced wholesale.

import fs from "fs";
import path from "path";

let failed = false;

function patch(rel, edits) {
  const p = path.join(process.cwd(), rel);
  if (!fs.existsSync(p)) { console.log(`!! ${rel} not found`); failed = true; return; }

  let s = fs.readFileSync(p, "utf8");
  let done = 0;

  for (const [find, replace, label] of edits) {
    if (s.includes(replace)) { console.log(`   already done: ${label}`); done++; continue; }
    if (!s.includes(find)) {
      console.log(`!! ${rel}: could not find the line for "${label}"`);
      failed = true; continue;
    }
    if (s.split(find).length - 1 > 1) {
      console.log(`!! ${rel}: "${label}" matches more than once - stopping`);
      failed = true; continue;
    }
    s = s.replace(find, replace);
    done++;
  }

  if (!failed) { fs.writeFileSync(p, s, "utf8"); console.log(`  patched ${rel} (${done})`); }
}

/* --- 1. in_transit gets its own flag, no longer shares the shipped one --- */

patch("app/lib/notify.server.ts", [[
`    in_transit: "onFulfilled",`,
`    in_transit: "onInTransit",`,
"separate flag",
]]);

/* --- 2. admin page: a switch for it, and save it --- */

patch("app/routes/app._index.tsx", [
  [
`        onFulfilled: on("onFulfilled"),`,
`        onFulfilled: on("onFulfilled"),
        onInTransit: on("onInTransit"),`,
    "save the switch",
  ],
  [
`          <Check label="Shipped + tracking" name="onFulfilled" defaultChecked={shop.onFulfilled} />`,
`          <Check label="Shipped + tracking" name="onFulfilled" defaultChecked={shop.onFulfilled} />
          <Check label="In transit" name="onInTransit" defaultChecked={shop.onInTransit}
            help="Goes out once per order, the first time the courier scans it in transit - not on every hub. Worth turning on only for long routes, where it reassures. On a three-day delivery it lands right after the shipped message and reads as a repeat." />`,
    "the switch itself",
  ],
]);

/* --- 3. schema --- */

const SCHEMA = path.join(process.cwd(), "prisma", "schema.prisma");
if (!fs.existsSync(SCHEMA)) {
  console.log("!! prisma/schema.prisma not found");
  failed = true;
} else {
  let sch = fs.readFileSync(SCHEMA, "utf8");
  if (/^\s*onInTransit\s/m.test(sch)) {
    console.log("   already done: schema field");
  } else if (!/^\s*onFulfilled\s/m.test(sch)) {
    console.log("!! could not find onFulfilled in the schema - add this next to it by hand:");
    console.log("     onInTransit Boolean @default(false)");
    failed = true;
  } else {
    sch = sch.replace(
      /^([ \t]*)onFulfilled(\s+Boolean\s+@default\(true\))/m,
      `$1onFulfilled$2\n` +
      `$1/// Off by default. It fires once per order, on the first in-transit scan,\n` +
      `$1/// which on a short route lands moments after the shipped message.\n` +
      `$1onInTransit      Boolean @default(false)`,
    );
    fs.writeFileSync(SCHEMA, sch, "utf8");
    console.log("  patched prisma/schema.prisma");
  }
}

console.log(failed
  ? `
================================================================
 STOPPED - nothing was half-applied.
 Send the message above and I will adjust the patch.
================================================================
`
  : `
================================================================
 Done. With 'shopify app dev' NOT running:

   npx prisma migrate dev --name in_transit_switch
   git add . && git commit -m "separate in transit switch" && git push

 The switch starts OFF. Turn it on from the app when you want it.
================================================================
`);
