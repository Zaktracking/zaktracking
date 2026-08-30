import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, renderMessage, eventEnabled } from "../lib/notify.server";

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

  const body = await renderMessage(s.id, "cancelled", "whatsapp", {
    name: rec.customerName || "there",
    order: rec.orderNumber,
    amount: "",
    link: "",
  });

  if (body) {
    await queueMessage({
      shopId: s.id,
      orderId: rec.id,
      channel: "whatsapp",
      event: "cancelled",
      to: rec.phone,
      body,
    });
  }

  return new Response();
};
