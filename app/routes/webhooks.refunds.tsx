import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";
import db from "../db.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, amountVar } from "../lib/templates.server";
import { startRefund, paymentForOrder } from "../lib/refund.server";
import { orderState } from "../lib/orders.server";

/**
 * Money going back.
 *
 * Shopify fires this the instant a refund is recorded - which, when an
 * order is cancelled with a refund, is the same second as orders/cancelled.
 * Both used to speak, and the customer got two messages a few milliseconds
 * apart saying much the same thing, in whatever order WhatsApp happened to
 * deliver them. The cancellation is the news at that moment, so it is the
 * only thing said then.
 *
 * What happens to the refund itself depends on who took the money:
 *
 *   - the popup took it, through Razorpay directly. Shopify cannot move
 *     that money; it only writes a note. So the app asks Razorpay to send
 *     it back for real, and the customer hears about the refund later, when
 *     Razorpay says it has actually gone (see refund.server.ts).
 *
 *   - Shopify's own gateway took it. Shopify has already sent the money
 *     back by the time this arrives, so there is nothing to do but say so -
 *     unless the order was just cancelled, in which case the cancellation
 *     message has already said it.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const refund = payload as any;
  const s = await ensureShop(shop);

  const rec = await db.orderRecord.findUnique({
    where: { shopId_shopifyId: { shopId: s.id, shopifyId: String(refund.order_id) } },
  });
  if (!rec) {
    console.log(`[refunds] order ${refund.order_id} is not one of ours`);
    return new Response();
  }

  // What Shopify says is going back. A refund transaction is born "pending"
  // and turns "success" a moment later, and refunds/create never fires
  // again - so pending counts. Only one that actually failed is passed over.
  let paid = 0;
  for (const t of refund.transactions ?? []) {
    const st = String(t?.status ?? "").toLowerCase();
    if (st && st !== "success" && st !== "pending") continue;
    const n = Number(t?.amount);
    if (Number.isFinite(n)) paid += n;
  }

  // No refund transaction at all means no money is moving - an order that
  // was never actually paid, cancelled to tidy the list.
  if (paid <= 0) {
    console.log(`[refunds] ${rec.orderNumber}: no money is going back, no message`);
    return new Response();
  }

  // The popup's own orders: Shopify's note is not a refund. Ask Razorpay to
  // send the money back, and say nothing yet - the customer is told when it
  // has gone, by the clock job.
  const ours = await paymentForOrder(s.id, rec.shopifyId);
  if (ours) {
    await startRefund({ shop: s, shopifyId: rec.shopifyId, orderNumber: rec.orderNumber, amount: paid });
    return new Response();
  }

  // Everything below is a refund Shopify's own gateway has already made.
  if (!eventEnabled(s, "refunded")) return new Response();

  // Cancelled in this breath? Then orders/cancelled is speaking, and it
  // says the refund is coming. Two messages in one second is noise.
  //
  // Shopify is asked rather than our own row: both webhooks are delivered
  // in the same instant and run side by side, so cancelledAt here is often
  // still empty when this one reads it. Shopify always knows.
  let cancelledAt: Date | null = rec.cancelledAt ? new Date(rec.cancelledAt) : null;
  if (!cancelledAt) {
    const live = await orderState(shop, rec.shopifyId);
    if (live?.cancelledAt) cancelledAt = new Date(live.cancelledAt);
  }
  if (cancelledAt && Date.now() - cancelledAt.getTime() < 10 * 60 * 1000) {
    console.log(`[refunds] ${rec.orderNumber} was just cancelled - the cancellation message covers it`);
    return new Response();
  }

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.amount = amountVar(String(paid), rec.currency);
  v.order = rec.orderNumber;
  v.item = rec.itemLine || "your order";
  v.method = rec.gateway || "your original payment method";

  await queueMessage({
    shopId: s.id,
    orderId: rec.id,
    event: "refunded",
    to: rec.phone,
    vars: v,
  });

  return new Response();
};
