import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";

/**
 * GDPR: a customer is requesting their data.
 *
 * Shopify only tells us who asked - WE have to send the data to the
 * merchant ourselves, within 30 days. For now we only log it; actually
 * sending the mail comes in Phase 3, once email is set up.
 *
 * These three GDPR webhooks are MANDATORY for a public app. Without them
 * Shopify's app review rejects the app.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const p = payload as any;
  const s = await ensureShop(shop);

  const orders = await db.orderRecord.findMany({
    where: { shopId: s.id, shopifyId: { in: (p.orders_requested ?? []).map(String) } },
    include: { messages: true, shipments: true },
  });

  console.log(
    `[gdpr/data_request] ${shop} customer ${p.customer?.id} -> ${orders.length} orders`,
  );

  return new Response();
};
