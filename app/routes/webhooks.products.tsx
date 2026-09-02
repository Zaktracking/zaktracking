import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop } from "../lib/webhook.server";
import { notifyBackInStock } from "../lib/followups.server";

/**
 * Stock coming back.
 *
 * This is the only webhook that carries a variant's new quantity, so it is
 * where the waiting list is served. Everyone who asked about a variant that
 * now has stock gets told once; the rest of the payload is ignored.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const product = payload as any;
  const s = await ensureShop(shop);

  for (const variant of product?.variants ?? []) {
    const qty = Number(variant?.inventory_quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    await notifyBackInStock(s.id, String(variant.id), variant?.price ?? null);
  }

  return new Response();
};
