import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";
import { registerNumbers, ALREADY_REGISTERED } from "../lib/track.server";

/**
 * This is where the route to "out for delivery" and "delivered" starts.
 *
 * Shopify never sends those two statuses - they live with the courier.
 * Here we grab the tracking number and register it with 17TRACK right away.
 * After that every courier scan is pushed to our server automatically.
 *
 * We register immediately rather than waiting for cron: the first scan comes
 * within the first hour of the parcel shipping. Registering 15 minutes late
 * would mean missing that first scan.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const f = payload as any;
  const s = await ensureShop(shop);

  const rec = await db.orderRecord.findUnique({
    where: { shopId_shopifyId: { shopId: s.id, shopifyId: String(f.order_id) } },
  });

  if (!rec) {
    console.log(`[fulfillments] order ${f.order_id} not found in DB`);
    return new Response();
  }

  const trackingNo = f.tracking_number ?? (f.tracking_numbers ?? [])[0] ?? null;
  const trackUrl = f.tracking_url ?? (f.tracking_urls ?? [])[0] ?? null;

  const ship = await db.shipment.upsert({
    where: {
      orderId_fulfillmentId: { orderId: rec.id, fulfillmentId: String(f.id) },
    },
    update: {
      trackingNo,
      carrier: f.tracking_company ?? null,
      trackUrl,
    },
    create: {
      orderId: rec.id,
      fulfillmentId: String(f.id),
      trackingNo,
      carrier: f.tracking_company ?? null,
      trackUrl,
      status: "pending",
    },
  });

  console.log(
    `[fulfillments] ${rec.orderNumber} -> ${f.tracking_company ?? "?"} ${trackingNo ?? "(no number yet)"}`,
  );

  /* ---------- register with 17TRACK ---------- */

  // No number, or already registered, or no key filled in - in all three
  // cases we bail out quietly. Cron will pick it up later.
  if (!trackingNo || ship.registered || !s.trackApiKey) return new Response();

  const res = await registerNumbers(s.trackApiKey, [
    { number: trackingNo, order_no: rec.orderNumber, tag: ship.id, param: ship.id },
  ]);

  const rejected = res.rejected?.[0];
  const already = rejected?.error?.code === ALREADY_REGISTERED;
  const ok = res.ok && (res.accepted.length > 0 || already);

  await db.shipment.update({
    where: { id: ship.id },
    data: { registered: ok, regTries: { increment: 1 } },
  });

  console.log(
    ok
      ? `[17track] ${trackingNo} registered`
      : `[17track] ${trackingNo} not registered: ${res.error ?? rejected?.error?.message ?? "?"} (cron will retry)`,
  );

  return new Response();
};
