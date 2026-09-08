import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";
import db from "../db.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, amountVar } from "../lib/templates.server";

/**
 * Money going back.
 *
 * A refund is the one moment a customer is most likely to think they have
 * been forgotten, so it is worth a message even though it costs one. The
 * amount is added up from the refund's own transactions - the order total
 * is the wrong figure when only part of it comes back.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const refund = payload as any;
  const s = await ensureShop(shop);
  if (!eventEnabled(s, "refunded")) return new Response();

  const rec = await db.orderRecord.findUnique({
    where: { shopId_shopifyId: { shopId: s.id, shopifyId: String(refund.order_id) } },
  });
  if (!rec) {
    console.log(`[refunds] order ${refund.order_id} is not one of ours`);
    return new Response();
  }

  let paid = 0;
  let via = "";
  for (const t of refund.transactions ?? []) {
    // A gateway refund is born "pending" and only turns "success" a moment
    // later, once the bank has taken it - and refunds/create is fired once
    // and never again. Waiting here for settled money therefore meant the
    // message was never sent at all: the refund the customer was told about
    // by email arrived in no WhatsApp of ours. The template is named
    // refund_initiated and says three to five working days in its own
    // words, so pending is exactly the moment it was written for. Only a
    // refund that actually failed is passed over.
    const st = String(t?.status ?? "").toLowerCase();
    if (st && st !== "success" && st !== "pending") continue;
    const n = Number(t?.amount);
    if (Number.isFinite(n)) paid += n;
    if (!via && t?.gateway) via = String(t.gateway);
  }
  // No refund transaction at all means no money is moving - an order that
  // was never actually paid, cancelled to tidy the list. Saying "refunded"
  // there would frighten someone who was never charged.
  if (paid <= 0) {
    console.log(`[refunds] ${rec.orderNumber}: no money is going back, no message`);
    return new Response();
  }

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.amount = amountVar(String(paid), rec.currency);
  v.order = rec.orderNumber;
  v.item = rec.itemLine || "your order";
  // Only the previous wording of the template still reads this; the
  // gateway's name ("razorpay") is not what a customer calls their bank.
  v.method = via || rec.gateway || "your original payment method";

  await queueMessage({
    shopId: s.id,
    orderId: rec.id,
    event: "refunded",
    to: rec.phone,
    vars: v,
  });

  return new Response();
};
