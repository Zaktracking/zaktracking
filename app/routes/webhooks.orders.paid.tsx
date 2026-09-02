import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, money, etaRange, orderTotal } from "../lib/templates.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);

  // upsert, not findUnique: orders/create and orders/paid can arrive in the
  // same second, and sometimes in the reverse order. Whichever lands first
  // creates the row and fills in isCod correctly.
  const rec = await upsertOrder(s.id, order);

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
  v.amount = money(orderTotal(order), order.currency);
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
