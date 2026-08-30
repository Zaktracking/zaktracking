import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, renderMessage, eventEnabled } from "../lib/notify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);
  const rec = await upsertOrder(s.id, order);

  // Tracking link: pehla fulfillment jisme tracking ho.
  const f = (order.fulfillments ?? []).find(
    (x: any) => x.tracking_url || x.tracking_number,
  );
  const link =
    f?.tracking_url ||
    (f?.tracking_number ? `https://${shop}/apps/track?n=${f.tracking_number}` : "");

  if (!eventEnabled(s, "shipped")) return new Response();

  const body = await renderMessage(s.id, "shipped", "whatsapp", {
    name: rec.customerName || "there",
    order: rec.orderNumber,
    amount: "",
    link,
  });

  if (body) {
    await queueMessage({
      shopId: s.id,
      orderId: rec.id,
      channel: "whatsapp",
      event: "shipped",
      to: rec.phone,
      body,
    });
  }

  return new Response();
};
