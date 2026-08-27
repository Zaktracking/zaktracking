import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { firstDelivery, ensureShop, toE164 } from "../lib/webhook.server";

/**
 * Abandoned cart.
 *
 * checkouts/update fires ten to fifteen times for a single shopper -
 * every time they change a quantity, type an address, anything at all.
 * So we send NO message here. We only upsert on the token and push
 * lastSeenAt forward.
 *
 * A separate scheduled job will send the reminder (Phase 2), checking:
 *   lastSeenAt is 1 hour old + convertedAt is empty -> reminder 1
 *   lastSeenAt is 24 hours old + convertedAt is empty -> reminder 2
 *
 * And as soon as the order arrives, convertedAt gets filled in - after that
 * no reminder goes out. Otherwise someone who just bought would also get
 * "your cart is waiting", which is the worst possible experience.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const c = payload as any;
  const s = await ensureShop(shop);

  const token = String(c.token ?? c.cart_token ?? c.id ?? "");
  if (!token) return new Response();

  const phone = toE164(
    c.phone || c.customer?.phone || c.shipping_address?.phone || null,
  );

  // With no phone number the message cannot go out - no point creating a row.
  if (!phone) return new Response();

  const name =
    c.customer?.first_name || c.shipping_address?.first_name || "";

  const data = {
    phone,
    name: String(name).trim() || null,
    recoverUrl: c.abandoned_checkout_url ?? null,
    total: c.total_price ?? null,
    currency: c.currency ?? null,
    itemCount: (c.line_items ?? []).length,
    lastSeenAt: new Date(),
  };

  await db.abandonedCart.upsert({
    where: { shopId_token: { shopId: s.id, token } },
    update: data,
    create: { shopId: s.id, token, ...data },
  });

  return new Response();
};
