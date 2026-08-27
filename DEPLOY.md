# Putting ZakTracking online

All of this is free. Two accounts are needed - Neon (the database) and Render
(the server). Both let you sign in with GitHub.

Do the steps in order. Each one depends on the one before it.

---

## 1. Database - Neon

1. https://neon.com -> **Sign up** with GitHub
2. Create a project. Name `zaktracking`, region **Singapore** (closest to India)
3. Copy the **connection string** from the dashboard. It looks like:

       postgresql://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require

If Neon offers a **pooled** connection string, take that one. A web server opens
and closes connections all day, and the pooler is what stops the database
running out of them.

---

## 2. Point the local project at Neon and create the tables

Open `.env` in the project folder. Add one line (or replace it if it is there):

    DATABASE_URL=postgresql://...the string from step 1...

Then, with `shopify app dev` **stopped**:

    npx prisma migrate dev --name init

This writes a fresh `prisma/migrations` folder for Postgres and creates every
table in Neon.

> The old migrations were written for SQLite and cannot run on Postgres. The
> installer moved them to `prisma/migrations-sqlite-backup` - nothing was
> deleted, and that folder can be removed later once everything works.
>
> The two test orders in the old `dev.sqlite` do not come across. That is fine -
> they were test data. Real orders will arrive into Neon from now on.

---

## 3. Code on GitHub

From the project folder:

    git init
    git add .
    git commit -m "ZakTracking"
    git branch -M main

Before pushing, check that secrets are staying behind:

    git status

`.env` must **not** appear in the list. It is already in `.gitignore`.

Now make an empty **private** repo on github.com called `zaktracking`, and run
the two lines GitHub shows:

    git remote add origin https://github.com/<your-username>/zaktracking.git
    git push -u origin main

---

## 4. Server - Render

1. https://render.com -> **Sign up** with GitHub
2. **New +** -> **Web Service** -> pick the `zaktracking` repo
3. Render reads `render.yaml` and fills most of it in. Confirm:
   - Plan **Free**, Region **Singapore**
   - Build: `npm install --legacy-peer-deps && npx prisma generate && npx prisma migrate deploy && npm run build`
   - Start: `npm run start`
4. Add the environment variables (Render calls this section *Environment*).
   Copy the values from your local `.env`:

   | Key | Where it comes from |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 1 |
   | `SHOPIFY_API_KEY` | local `.env` |
   | `SHOPIFY_API_SECRET` | local `.env` |
   | `SCOPES` | local `.env` |
   | `CRON_SECRET` | local `.env` |
   | `NODE_VERSION` | `22` |

   Leave `SHOPIFY_APP_URL` for the next step.

5. **Create Web Service**. The first build takes a few minutes.
6. Render gives a URL like `https://zaktracking.onrender.com`. Copy it.

---

## 5. Tell Shopify the new address

1. On Render, set `SHOPIFY_APP_URL` to that URL, then
   **Manual Deploy -> Deploy latest commit**.
2. On your computer, edit `shopify.app.toml`:

       application_url = "https://zaktracking.onrender.com"

       [auth]
       redirect_urls = [ "https://zaktracking.onrender.com/auth/callback" ]

3. From the project folder:

       shopify app deploy

   This moves the app to the new address and re-registers all eleven webhooks
   against it.

---

## 6. The cron

Every 10 minutes the app needs a nudge: register new tracking numbers with
17TRACK, pick up whatever the push missed, and send abandoned-cart reminders.
The same request also keeps the free Render service awake, so nothing extra is
needed for that.

1. https://cron-job.org -> sign up (free)
2. **Create cronjob**
   - URL: `https://zaktracking.onrender.com/api/cron?key=<your CRON_SECRET>`
   - Every **10 minutes**
   - Save

Open that URL once in a browser. It should answer with something like
`{"registered":0,"polled":0,"changed":0,...}`. If it says `nope`, the key is
wrong.

---

## 7. 17TRACK webhook - the permanent one

https://api.17track.net/admin/settings -> **Package Webhook** -> URL:

    https://zaktracking.onrender.com/api/track-webhook

Version **V 2.2**. Save.

This is the last time it needs changing. The tunnel address moved on every
restart; this one stays.

---

## 8. Check it end to end

1. Open the app from Shopify admin. The settings page will be **empty** - the
   old values lived in the SQLite file on the laptop, not in Neon. Enter the
   phone number ID, WABA ID, token and 17TRACK key once more and **Save**.
   The terminal equivalent now lives in Render -> **Logs**.
2. 17TRACK settings -> **Test**. Render logs should show
   `[track-webhook] TRACKING_UPDATED - ... parcels processed`.
3. Place a test order in the store. Render logs should show `[orders/create]`.

Once that passes, the laptop can be closed. `shopify app dev` is only needed
when the code changes.
