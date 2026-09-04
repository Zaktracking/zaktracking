import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, money, amountVar, etaRange, orderTotal } from "../lib/templates.server";
import { replacedOrderNumber } from "../lib/paynow.server";
import { cancelOrder } from "../lib/orders.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);

  // upsert, not findUnique: orders/create and orders/paid can arrive in the
  // same second, and sometimes in the reverse order. Whichever lands first
  // creates the row and fills in isCod correctly.
  const rec = await upsertOrder(s.id, order);

  // This order may be the paid replacement for a COD one - the customer
  // took the Pay Now button on their confirmation. Now that the money is
  // in, the COD original is cancelled, so nothing is ever packed twice.
  const replaces = replacedOrderNumber(order);
  if (replaces && replaces !== rec.orderNumber) {
    const old = await db.orderRecord.findFirst({
      where: { shopId: s.id, orderNumber: replaces, cancelledAt: null },
    });
    if (old) {
      const done = await cancelOrder(
        shop,
        old.shopifyId,
        `Paid online instead - replaced by ${rec.orderNumber}`,
      );
      if (done.ok) {
        await db.orderRecord.update({
          where: { id: old.id },
          data: { cancelledAt: new Date() },
        });
      }
      console.log(
        `[orders/paid] ${rec.orderNumber} replaces ${replaces} - ` +
          (done.ok ? "cancelled" : "could not cancel: " + done.error),
      );
    }
  }

  // A COD order fires orders/paid too - but WEEKS LATER, when the courier
  // deposits the cash. Sending "Payment received" then reads as spam; the
  // parcel was delivered long ago.
  if (rec.isCod) {
    console.log(`[orders/paid] ${rec.orderNumber} is COD, no message sent`);
    return new Response();
  }

  // Second guard, for the partial-payment case. Shopify fires orders/paid
  // when the small advance is taken, while the rest is still owed at the
  // door. Saying "we have received your payment" then is simply untrue.
  const stillOwed = Number(order?.total_outstanding ?? 0);
  if (Number.isFinite(stillOwed) && stillOwed > 0) {
    console.log(
      `[orders/paid] ${rec.orderNumber} still has ${stillOwed} outstanding, no message sent`,
    );
    return new Response();
  }

  if (!eventEnabled(s, "order_paid")) return new Response();

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.order = rec.orderNumber;
  v.item = itemLine(order);
  v.amount = amountVar(orderTotal(order), order.currency);
  v.eta = etaRange();

  await queueMessage({
    shopId: s.id,
    orderId: rec.id,
    event: "order_paid",
    to: rec.phone,
    vars: v,
  });

  return new Response();
};
