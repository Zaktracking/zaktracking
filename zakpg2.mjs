#!/usr/bin/env node
// ZakTracking - use Neon's direct endpoint for migrations
// Run with:  node zakpg2.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";

const F = {};

let n = 0;
for (const [rel, body] of Object.entries(F)) {
  const p = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  console.log("  wrote  " + rel);
  n++;
}
console.log("");

/* ------- prisma/schema.prisma: add directUrl for migrations ------- */

const SCHEMA = path.join(process.cwd(), "prisma", "schema.prisma");

if (!fs.existsSync(SCHEMA)) {
  console.log("!! prisma/schema.prisma not found. Are you in the project folder?");
  process.exit(1);
}

let sch = fs.readFileSync(SCHEMA, "utf8");

if (/directUrl/.test(sch)) {
  console.log("  directUrl is already set");
} else {
  const before = sch;
  sch = sch.replace(
    /datasource\s+db\s*\{[^}]*\}/,
    [
      "datasource db {",
      '  provider  = "postgresql"',
      "  // The app runs through Neon's pooler: a web server opens and closes",
      "  // connections all day, and the pooler is what keeps the database from",
      "  // running out of them.",
      '  url       = env("DATABASE_URL")',
      "  // Migrations cannot go through the pooler - they need advisory locks",
      "  // and DDL that PgBouncer does not pass through. So they take the",
      "  // direct endpoint instead.",
      '  directUrl = env("DIRECT_URL")',
      "}",
    ].join("\n"),
  );

  if (sch === before) {
    console.log("!! could not find the datasource block - add this line by hand:");
    console.log('     directUrl = env("DIRECT_URL")');
  } else {
    fs.writeFileSync(SCHEMA, sch, "utf8");
    console.log("  directUrl added to the datasource");
  }
}

console.log(`
================================================================
 Now put BOTH lines in .env:

   DATABASE_URL=<the POOLED string, the one with -pooler in it>
   DIRECT_URL=<the DIRECT string, the same one WITHOUT -pooler>

 In Neon: Connection string box -> the toggle/dropdown that says
 "Pooled connection". On = pooled, off = direct. Copy both.

 Then, with 'shopify app dev' stopped:

   npx prisma migrate dev --name init
================================================================
`);
