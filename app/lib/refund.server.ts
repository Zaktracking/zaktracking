/**
 * Money going back, actually going back.
 *
 * Cancelling a prepaid order in Shopify looks finished from the admin's
 * side: the order says REFUNDED and a refund transaction appears against
 * it. But for an order this app wrote, that transaction is only a note.
 * The payment was taken by Razorpay directly, not through Shopify's own
 * Razorpay gateway, so Shopify has no way to move the money - it simply
 * records that the merchant says it was moved. Until someone opens the
 * Razorpay dashboard, the customer's money has not gone anywhere.
 *
 * So the app does it: Shopify's refund tells us the amount, Razorpay is
 * asked to send exactly that back, and the customer is told only once
 * Razorpay reports the money has left. Two messages, days apart, each true
 * when it is sent - not two in the same second saying the same thing.
 *
 * Nothing here can send money twice. Razorpay is asked what it has already
 * refunded against the payment before a new refund is made, and the refund
 * id is written down the moment it exists.
 */

import db from "../db.server";
import { rzpReady, createRefund, fetchRefund, refundsOf } from "./razorpay.server";
import { queueMessage, eventEnabled } from "./notify.server";
import { blankVars, amountVar } from "./templates.server";

/** Shopify hands us gid://shopify/Order/123; OrderRecord keeps the 123. */
function numericId(gidOrId: string | null | undefined): string {
  const s = String(gidOrId ?? "");
  const m = s.match(/(\d+)\s*$/);
  return m ? m[1] : s;
}

/**
 * The payment this app took for a Shopify order, if it took one.
 *
 * Only orders written by the popup have a row here. An order that came
 * through Shopify's own checkout has none, and Shopify's gateway refunds
 * that one by itself - there is nothing for us to do.
 */
export async function paymentForOrder(shopId: string, shopifyId: string) {
  const rows = await db.payment.findMany({
    where: { shopId, status: "ordered", rzpPayment: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.find((p) => numericId(p.orderId) === numericId(shopifyId)) ?? null;
}

/**
 * Asks Razorpay to send the money back.
 *
 * Called from the refunds webhook, so the amount is always the one Shopify
 * actually refunded - never a guess, and never anything if the merchant
 * cancelled an order without refunding it.
 */
export async function startRefund(opts: {
  shop: any;
  shopifyId: string;
  orderNumber: string;
  /** rupees, as Shopify reported them */
  amount: number;
}): Promise<"started" | "already" | "skipped" | "failed"> {
  const { shop, shopifyId, orderNumber } = opts;
  if (!rzpReady(shop)) return "skipped";

  const pay = await paymentForOrder(shop.id, shopifyId);
  if (!pay || !pay.rzpPayment) return "skipped";
  if (pay.refundId) {
    console.log(`[refund] ${orderNumber} was already sent back (${pay.refundId})`);
    return "already";
  }

  const paise = Math.round(opts.amount * 100);
  if (!(paise > 0)) return "skipped";

  try {
    // Razorpay's own record comes first. A webhook delivered twice, or a
    // merchant who already refunded by hand in the dashboard, must not end
    // up sending the money a second time.
    const had = await refundsOf(shop, pay.rzpPayment);
    const live = had.filter((r) => r.status !== "failed");
    if (live.length) {
      const r = live[0];
      await db.payment.update({
        where: { id: pay.id },
        data: { refundId: r.id, refundStatus: r.status, refundedAt: r.status === "processed" ? new Date() : null },
      });
      console.log(`[refund] ${orderNumber} already had a refund at Razorpay (${r.id}, ${r.status})`);
      return "already";
    }

    const r = await createRefund(shop, pay.rzpPayment, paise, {
      order: orderNumber,
      shop: String(shop.domain ?? ""),
    });
    await db.payment.update({
      where: { id: pay.id },
      data: { refundId: r.id, refundStatus: r.status, refundedAt: r.status === "processed" ? new Date() : null },
    });
    console.log(`[refund] ${orderNumber}: Rs ${opts.amount} sent back through Razorpay (${r.id}, ${r.status})`);
    return "started";
  } catch (e: any) {
    const why = String(e?.message ?? e);
    await db.payment.update({
      where: { id: pay.id },
      data: { refundStatus: "failed", error: `refund: ${why}` },
    }).catch(() => {});
    console.log(`[refund] ${orderNumber}: Razorpay refused the refund - ${why}`);
    return "failed";
  }
}

/**
 * Tells the customer, once it is true.
 *
 * The clock job asks Razorpay about every refund still on its way. The
 * moment one is processed - the money has left Razorpay - that is when the
 * "your refund is on its way to your account" message goes, and not before.
 */
export async function sweepRefunds(): Promise<number> {
  let waiting;
  try {
    waiting = await db.payment.findMany({
      where: { refundId: { not: null }, refundStatus: { notIn: ["processed", "failed"] } },
      orderBy: { updatedAt: "asc" },
      take: 50,
    });
  } catch (e: any) {
    console.log(`[refund] could not read the refund queue: ${e?.message ?? e}`);
    return 0;
  }

  let told = 0;
  for (const pay of waiting) {
    const shop = await db.shop.findUnique({ where: { id: pay.shopId } });
    if (!shop || !rzpReady(shop)) continue;

    let r;
    try {
      r = await fetchRefund(shop, String(pay.refundId));
    } catch (e: any) {
      console.log(`[refund] could not read ${pay.refundId}: ${e?.message ?? e}`);
      continue;
    }
    if (r.status === pay.refundStatus) continue;

    await db.payment.update({
      where: { id: pay.id },
      data: { refundStatus: r.status, refundedAt: r.status === "processed" ? new Date() : null },
    });

    if (r.status !== "processed") {
      console.log(`[refund] ${pay.orderName}: now ${r.status}`);
      continue;
    }

    const rec = pay.orderId
      ? await db.orderRecord.findFirst({
          where: { shopId: shop.id, shopifyId: numericId(pay.orderId) },
        })
      : null;
    console.log(`[refund] ${pay.orderName}: Razorpay has sent the money`);
    if (!rec || !eventEnabled(shop, "refunded")) continue;

    const v = blankVars();
    v.name = rec.customerName || "there";
    v.amount = amountVar(String(r.amount / 100), rec.currency);
    v.order = rec.orderNumber;
    v.item = rec.itemLine || "your order";
    v.method = "your original payment method";

    const row = await queueMessage({
      shopId: shop.id,
      orderId: rec.id,
      event: "refunded",
      to: rec.phone,
      vars: v,
    });
    if (row) told++;
  }

  return told;
}
