import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import db from "../db.server";
import {
  registerNumbers, getTrackInfo, chunk,
  ALREADY_REGISTERED, NO_CARRIER, QUOTA_OVER,
} from "../lib/track.server";
import { applyToShipment, FINAL } from "../lib/tracksync.server";
import { sweepAbandoned } from "../lib/abandoned.server";
import { sweepQueued } from "../lib/notify.server";
import { sweepCancelRequests } from "../lib/inbound.server";
import { sweepCodReminders, sweepCodAutoConfirm, sweepReviewRequests } from "../lib/followups.server";
import { sweepPayments } from "../lib/prepaid.server";

/**
 * The clock job.
 *
 * Call this once every 15 minutes (Render/Railway cron, or
 * cron-job.org works just as well):
 *
 *     https://<app-url>/api/cron?key=<CRON_SECRET>
 *
 * It does three things:
 *   1. Register new tracking numbers with 17TRACK
 *   2. Ask for the status of parcels still in transit (in case a push is missed)
 *   3. Abandoned cart reminders
 *   4. Cancellations the customer asked for, once the grace period is over
 *
 * The push (webhook) arrives instantly, this is its backup. We need both -
 * push is fast but drops occasionally, polling is slow but reliable.
 */

const THREE_HOURS = 3 * 60 * 60 * 1000;

async function run() {
  const out = {
    registered: 0,
    regFailed: 0,
    polled: 0,
    changed: 0,
    abandoned1: 0,
    abandoned2: 0,
    codReminders: 0,
    codAutoConfirmed: 0,
    reviews: 0,
    cancelled: 0,
    cancelTooLate: 0,
    paidOrders: 0,
    retried: 0,
    notes: [] as string[],
  };

  const shops = await db.shop.findMany({ where: { trackApiKey: { not: null } } });

  for (const shop of shops) {
    const key = shop.trackApiKey!;

    /* ---------- 1. register ---------- */
    const fresh = await db.shipment.findMany({
      where: {
        registered: false,
        regTries: { lt: 5 },
        trackingNo: { not: null },
        order: { shopId: shop.id },
      },
      include: { order: true },
      take: 80,
    });

    for (const batch of chunk(fresh, 40)) {
      const res = await registerNumbers(
        key,
        batch.map((s) => ({
          number: s.trackingNo!,
          order_no: s.order.orderNumber,
          tag: s.id,
          param: s.id,
        })),
      );

      // The whole call failed - quota exhausted or a bad key. We bump the
      // try count so it does not hammer this a thousand times every 15 minutes.
      if (!res.ok) {
        out.notes.push(`register: ${res.error}`);
        await db.shipment.updateMany({
          where: { id: { in: batch.map((s) => s.id) } },
          data: { regTries: { increment: 1 } },
        });
        if (res.code === QUOTA_OVER) out.notes.push("17TRACK quota exhausted");
        break;
      }

      const okNums = new Set(res.accepted.map((a: any) => String(a.number)));
      const permanentFail = new Set<string>();

      for (const r of res.rejected) {
        const code = r?.error?.code;
        const num = String(r?.number ?? "");
        // "already registered" is not an error - it means tracking is running.
        if (code === ALREADY_REGISTERED) okNums.add(num);
        else if (code === NO_CARRIER) permanentFail.add(num);
        else out.notes.push(`${num}: ${r?.error?.message ?? code}`);
      }

      for (const s of batch) {
        const num = s.trackingNo!;
        if (okNums.has(num)) {
          await db.shipment.update({
            where: { id: s.id },
            data: { registered: true, regTries: { increment: 1 } },
          });
          out.registered++;
        } else {
          await db.shipment.update({
            where: { id: s.id },
            data: { regTries: { increment: permanentFail.has(num) ? 5 : 1 } },
          });
          out.regFailed++;
        }
      }
    }

    /* ---------- 2. poll status ---------- */
    const live = await db.shipment.findMany({
      where: {
        registered: true,
        trackingNo: { not: null },
        order: { shopId: shop.id },
        status: { notIn: Array.from(FINAL) },
        OR: [
          { lastEventAt: null },
          { lastEventAt: { lte: new Date(Date.now() - THREE_HOURS) } },
        ],
      },
      take: 40,
    });

    for (const batch of chunk(live, 40)) {
      const res = await getTrackInfo(key, batch.map((s) => s.trackingNo!));
      if (!res.ok) {
        out.notes.push(`gettrackinfo: ${res.error}`);
        break;
      }
      for (const node of res.accepted) {
        const num = String(node?.number ?? "");
        const s = batch.find((x) => x.trackingNo === num);
        if (!s) continue;
        const r = await applyToShipment(s.id, node);
        out.polled++;
        if (r?.changed) out.changed++;
      }
    }
  }

  /* ---------- 3. abandoned carts ---------- */
  const ab = await sweepAbandoned();
  out.abandoned1 = ab.sent1;
  out.abandoned2 = ab.sent2;

  /* ---------- 3b. online payments the browser never confirmed ----------
     A phone that dropped its connection the second after paying never told
     us. Razorpay is asked; a payment that went through gets its order. */
  try {
    out.paidOrders = (await sweepPayments()).ordered;
  } catch (e: any) {
    out.notes.push(`payments: ${e?.message ?? e}`);
  }

  /* ---------- 4. cancellations the customer asked for ----------
     Pressing Cancel on WhatsApp does not cancel anything at once. A
     cancelled Shopify order cannot be brought back, and a button is easy
     to press by accident. So the request waits out a grace period here,
     and a Confirm arriving in the meantime wipes it. */
  const cx = await sweepCancelRequests();
  out.cancelled = cx.cancelled;
  out.cancelTooLate = cx.tooLate;

  /* ---------- 5. the messages no webhook can fire ----------
     This runs for every shop, not only the ones with a tracking key: a COD
     nudge needs nothing from the courier. */
  for (const shop of await db.shop.findMany()) {
    out.codReminders += await sweepCodReminders(shop);
    out.codAutoConfirmed += await sweepCodAutoConfirm(shop);
    out.reviews += await sweepReviewRequests(shop);
  }

  /* ---------- 6. messages that failed for a passing reason ----------
     A send that fails on the network, or on Meta having a bad minute, used
     to be marked "queued" and left there - nothing in the app ever came
     back for it. Now it is given a handful of tries with growing gaps, and
     dropped once it is too old to be worth arriving. */
  try {
    out.retried = await sweepQueued();
  } catch (e: any) {
    out.notes.push(`retry sweep: ${e?.message ?? e}`);
  }

  console.log("[cron]", JSON.stringify(out));
  return out;
}

function guard(request: Request): Response | null {
  const url = new URL(request.url);
  const given = url.searchParams.get("key") ?? request.headers.get("x-cron-key");
  const want = process.env.CRON_SECRET;
  if (!want) return new Response("CRON_SECRET is not set in .env", { status: 500 });
  if (given !== want) return new Response("nope", { status: 401 });
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const bad = guard(request);
  if (bad) return bad;
  return Response.json(await run());
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const bad = guard(request);
  if (bad) return bad;
  return Response.json(await run());
};
