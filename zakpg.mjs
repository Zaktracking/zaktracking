#!/usr/bin/env node
// ZakTracking - move to Postgres and add the deploy files
// Run with:  node zakpg.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";

const F = {};
F["DEPLOY.md"] = "# Putting ZakTracking online\n\nAll of this is free. Two accounts are needed - Neon (the database) and Render\n(the server). Both let you sign in with GitHub.\n\nDo the steps in order. Each one depends on the one before it.\n\n---\n\n## 1. Database - Neon\n\n1. https://neon.com -> **Sign up** with GitHub\n2. Create a project. Name `zaktracking`, region **Singapore** (closest to India)\n3. Copy the **connection string** from the dashboard. It looks like:\n\n       postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require\n\nIf Neon offers a **pooled** connection string, take that one. A web server opens\nand closes connections all day, and the pooler is what stops the database\nrunning out of them.\n\n---\n\n## 2. Point the local project at Neon and create the tables\n\nOpen `.env` in the project folder. Add one line (or replace it if it is there):\n\n    DATABASE_URL=postgresql://...the string from step 1...\n\nThen, with `shopify app dev` **stopped**:\n\n    npx prisma migrate dev --name init\n\nThis writes a fresh `prisma/migrations` folder for Postgres and creates every\ntable in Neon.\n\n> The old migrations were written for SQLite and cannot run on Postgres. The\n> installer moved them to `prisma/migrations-sqlite-backup` - nothing was\n> deleted, and that folder can be removed later once everything works.\n>\n> The two test orders in the old `dev.sqlite` do not come across. That is fine -\n> they were test data. Real orders will arrive into Neon from now on.\n\n---\n\n## 3. Code on GitHub\n\nFrom the project folder:\n\n    git init\n    git add .\n    git commit -m \"ZakTracking\"\n    git branch -M main\n\nBefore pushing, check that secrets are staying behind:\n\n    git status\n\n`.env` must **not** appear in the list. It is already in `.gitignore`.\n\nNow make an empty **private** repo on github.com called `zaktracking`, and run\nthe two lines GitHub shows:\n\n    git remote add origin https://github.com/<your-username>/zaktracking.git\n    git push -u origin main\n\n---\n\n## 4. Server - Render\n\n1. https://render.com -> **Sign up** with GitHub\n2. **New +** -> **Web Service** -> pick the `zaktracking` repo\n3. Render reads `render.yaml` and fills most of it in. Confirm:\n   - Plan **Free**, Region **Singapore**\n   - Build: `npm install --legacy-peer-deps && npx prisma generate && npx prisma migrate deploy && npm run build`\n   - Start: `npm run start`\n4. Add the environment variables (Render calls this section *Environment*).\n   Copy the values from your local `.env`:\n\n   | Key | Where it comes from |\n   |---|---|\n   | `DATABASE_URL` | the Neon string from step 1 |\n   | `SHOPIFY_API_KEY` | local `.env` |\n   | `SHOPIFY_API_SECRET` | local `.env` |\n   | `SCOPES` | local `.env` |\n   | `CRON_SECRET` | local `.env` |\n   | `NODE_VERSION` | `22` |\n\n   Leave `SHOPIFY_APP_URL` for the next step.\n\n5. **Create Web Service**. The first build takes a few minutes.\n6. Render gives a URL like `https://zaktracking.onrender.com`. Copy it.\n\n---\n\n## 5. Tell Shopify the new address\n\n1. On Render, set `SHOPIFY_APP_URL` to that URL, then\n   **Manual Deploy -> Deploy latest commit**.\n2. On your computer, edit `shopify.app.toml`:\n\n       application_url = \"https://zaktracking.onrender.com\"\n\n       [auth]\n       redirect_urls = [ \"https://zaktracking.onrender.com/auth/callback\" ]\n\n3. From the project folder:\n\n       shopify app deploy\n\n   This moves the app to the new address and re-registers all eleven webhooks\n   against it.\n\n---\n\n## 6. The cron\n\nEvery 10 minutes the app needs a nudge: register new tracking numbers with\n17TRACK, pick up whatever the push missed, and send abandoned-cart reminders.\nThe same request also keeps the free Render service awake, so nothing extra is\nneeded for that.\n\n1. https://cron-job.org -> sign up (free)\n2. **Create cronjob**\n   - URL: `https://zaktracking.onrender.com/api/cron?key=<your CRON_SECRET>`\n   - Every **10 minutes**\n   - Save\n\nOpen that URL once in a browser. It should answer with something like\n`{\"registered\":0,\"polled\":0,\"changed\":0,...}`. If it says `nope`, the key is\nwrong.\n\n---\n\n## 7. 17TRACK webhook - the permanent one\n\nhttps://api.17track.net/admin/settings -> **Package Webhook** -> URL:\n\n    https://zaktracking.onrender.com/api/track-webhook\n\nVersion **V 2.2**. Save.\n\nThis is the last time it needs changing. The tunnel address moved on every\nrestart; this one stays.\n\n---\n\n## 8. Check it end to end\n\n1. Open the app from Shopify admin. The settings page will be **empty** - the\n   old values lived in the SQLite file on the laptop, not in Neon. Enter the\n   phone number ID, WABA ID, token and 17TRACK key once more and **Save**.\n   The terminal equivalent now lives in Render -> **Logs**.\n2. 17TRACK settings -> **Test**. Render logs should show\n   `[track-webhook] TRACKING_UPDATED - ... parcels processed`.\n3. Place a test order in the store. Render logs should show `[orders/create]`.\n\nOnce that passes, the laptop can be closed. `shopify app dev` is only needed\nwhen the code changes.\n";
F["render.yaml"] = "# Render blueprint for ZakTracking.\n#\n# The free plan gives 750 instance-hours a month, which covers one service\n# running the whole month. A free service sleeps after 15 minutes with no\n# traffic - but the cron that registers tracking numbers and sweeps abandoned\n# carts runs every 10 minutes anyway, so it keeps the service awake as a side\n# effect. No trick needed, and nothing extra to pay for.\n\nservices:\n  - type: web\n    name: zaktracking\n    runtime: node\n    plan: free\n    region: singapore          # closest region to India\n    branch: main\n    buildCommand: npm install --legacy-peer-deps && npx prisma generate && npx prisma migrate deploy && npm run build\n    startCommand: npm run start\n    envVars:\n      - key: NODE_VERSION\n        value: \"22\"\n      # Filled in from the Render dashboard - never commit these.\n      - key: DATABASE_URL\n        sync: false\n      - key: SHOPIFY_API_KEY\n        sync: false\n      - key: SHOPIFY_API_SECRET\n        sync: false\n      - key: SHOPIFY_APP_URL\n        sync: false\n      - key: SCOPES\n        sync: false\n      - key: CRON_SECRET\n        sync: false\n";

let n = 0;
for (const [rel, body] of Object.entries(F)) {
  const p = path.join(process.cwd(), rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf8");
  console.log("  wrote  " + rel);
  n++;
}
console.log("\n" + n + " files written.\n");

/* ---------------- prisma/schema.prisma: SQLite -> Postgres ---------------- */

const SCHEMA = path.join(process.cwd(), "prisma", "schema.prisma");

if (!fs.existsSync(SCHEMA)) {
  console.log("!! prisma/schema.prisma not found. Are you in the project folder?");
  process.exit(1);
}

let sch = fs.readFileSync(SCHEMA, "utf8");

if (/provider\s*=\s*"postgresql"/.test(sch)) {
  console.log("  schema is already on Postgres");
} else {
  const before = sch;

  sch = sch.replace(
    /datasource\s+db\s*\{[^}]*\}/,
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}',
  );

  if (sch === before) {
    console.log("!! could not find the datasource block - change it by hand:");
    console.log('     provider = "postgresql"');
    console.log('     url      = env("DATABASE_URL")');
  } else {
    fs.writeFileSync(SCHEMA, sch, "utf8");
    console.log("  schema switched to Postgres (DATABASE_URL)");
  }
}

/* ------- old SQLite migrations: moved aside, not deleted ------- */

const MIG = path.join(process.cwd(), "prisma", "migrations");
const BAK = path.join(process.cwd(), "prisma", "migrations-sqlite-backup");

if (fs.existsSync(MIG) && !fs.existsSync(BAK)) {
  fs.renameSync(MIG, BAK);
  console.log("  old SQLite migrations moved to prisma/migrations-sqlite-backup");
  console.log("  (nothing deleted - that folder can go once everything works)");
} else if (fs.existsSync(BAK)) {
  console.log("  SQLite migrations were already moved aside");
}

console.log(`
================================================================
 Next: open DEPLOY.md and follow it from step 1.

 In short:
   1. Neon        - free Postgres, copy the connection string
   2. .env        - DATABASE_URL=<that string>
                    npx prisma migrate dev --name init
   3. GitHub      - push the code (.env stays behind)
   4. Render      - free web service from the repo
   5. shopify app deploy with the new URL
   6. cron-job.org every 10 minutes
   7. 17TRACK webhook -> the permanent URL

 Do not run 'prisma migrate' while 'shopify app dev' is running.
================================================================
`);
