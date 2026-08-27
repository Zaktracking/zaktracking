import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery } from "../lib/webhook.server";

/**
 * GDPR: 48 hours have passed since the app was uninstalled - erase all of
 * this store's data now.
 *
 * Deleting the shop takes everything else (orders, shipments, messages,
 * carts) with it automatically, because the schema has onDelete: Cascade.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  await db.shop.deleteMany({ where: { domain: shop } });
  await db.session.deleteMany({ where: { shop } });

  console.log(`[gdpr/shop_redact] erased all data for ${shop}`);

  return new Response();
};
