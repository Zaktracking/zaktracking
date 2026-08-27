import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";

/**
 * GDPR: erase a customer's data.
 *
 * We keep the order row (the merchant needs their own records), but strip
 * out of it everything a person could be identified by - name, phone,
 * email - along with all of their messages.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const p = payload as any;
  const s = await ensureShop(shop);

  const ids = (p.orders_to_redact ?? []).map(String);
  if (!ids.length) return new Response();

  const orders = await db.orderRecord.findMany({
    where: { shopId: s.id, shopifyId: { in: ids } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  await db.messageLog.deleteMany({ where: { orderId: { in: orderIds } } });

  await db.orderRecord.updateMany({
    where: { id: { in: orderIds } },
    data: { customerName: null, phone: null, email: null },
  });

  console.log(`[gdpr/redact] ${shop} -> ${orderIds.length} orders cleaned`);

  return new Response();
};
