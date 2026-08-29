import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, money, etaRange, orderTotal } from "../lib/templates.server";
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
  v.amount = money(orderTotal(order), order.currency);
  v.eta = etaRange();

  // For COD we ask for confirmation, for prepaid we send "order received".
  // Getting COD confirmed cuts RTO (the parcel coming back) the most.
  const event = rec.isCod && s.codConfirm ? "cod_confirm" : "order_created";

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
