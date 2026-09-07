import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, amountVar, orderTotal } from "../lib/templates.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);
  const rec = await upsertOrder(s.id, order);

  await db.orderRecord.update({
    where: { id: rec.id },
    data: { cancelledAt: new Date() },
  });

  if (!eventEnabled(s, "cancelled")) return new Response();

  // The COD twin of an order that was just paid online: from where the
  // customer stands nothing was cancelled - they paid, and the payment
  // message has already thanked them. A cancellation notice now would only
  // alarm them.
  if (rec.cancelReason === "paid_online") {
    console.log(`[cancelled] ${rec.orderNumber} was replaced by an online payment - no message`);
    return new Response();
  }

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.order = rec.orderNumber;
  v.item = itemLine(order);
  v.amount = amountVar(orderTotal(order), order.currency);

  await queueMessage({
    shopId: s.id,
    orderId: rec.id,
    event: "cancelled",
    to: rec.phone,
    vars: v,
  });

  return new Response();
};
