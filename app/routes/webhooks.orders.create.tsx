import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, amountVar, etaDate, orderTotal } from "../lib/templates.server";
import { markConverted } from "../lib/abandoned.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);
  const rec = await upsertOrder(s.id, order);

  // This first. Sending "your cart is waiting" to someone who has just
  // bought is the worst possible experience - and it also costs money at
  // the Marketing rate.
  await markConverted(s.id, [order.cart_token, order.checkout_token, order.checkout_id]);

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.order = rec.orderNumber;
  v.item = itemLine(order);
  v.amount = amountVar(orderTotal(order), order.currency);
  v.eta = etaDate(new Date(), 7);

  // A prepaid order that came through Shopify's checkout says nothing here:
  // orders/paid follows within seconds and its "payment received" is the
  // confirmation - one message, not two that say the same thing.
  //
  // But an order this app writes itself is born already paid. There is no
  // payment event for Shopify to announce, so orders/paid never fires and
  // that confirmation was never sent - the customer paid and heard nothing.
  // So when the order arrives already settled, it is said here. If
  // orders/paid does turn up as well, MessageLog's unique(order, event)
  // turns the second one away.
  if (!rec.isCod) {
    const settled = String(order?.financial_status ?? "").toLowerCase() === "paid";
    const owed = Number(order?.total_outstanding ?? 0);
    if (settled && !(Number.isFinite(owed) && owed > 0) && eventEnabled(s, "order_paid")) {
      await queueMessage({
        shopId: s.id,
        orderId: rec.id,
        event: "order_paid",
        to: rec.phone,
        vars: v,
      });
    }
    return new Response();
  }
  const event = eventEnabled(s, "cod_confirm") ? "cod_confirm" : "order_created";

  if (eventEnabled(s, event)) {
    await queueMessage({
      shopId: s.id,
      orderId: rec.id,
      event,
      to: rec.phone,
      vars: v,
    });
  }

  return new Response();
};
