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

  const vars = {
    name: rec.customerName || "there",
    order: rec.orderNumber,
    amount: `${order.currency ?? ""} ${order.total_price ?? ""}`.trim(),
    link: "",
  };

  // COD par confirmation maangte hain, prepaid par seedha "order mil gaya".
  // COD confirm karwana RTO (parcel wapas aana) sabse zyada kam karta hai.
  const event = rec.isCod && s.codConfirm ? "cod_confirm" : "order_created";

  if (eventEnabled(s, event)) {
    const body = await renderMessage(s.id, event, "whatsapp", vars);
    if (body) {
      await queueMessage({
        shopId: s.id,
        orderId: rec.id,
        channel: "whatsapp",
        event,
        to: rec.phone,
        body,
      });
    }
  }

  return new Response();
};
