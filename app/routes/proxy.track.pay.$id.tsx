import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy } from "../lib/proxy.server";
import { payUrl } from "../lib/paynow.server";

/**
 * Short link behind the Pay Now button on the confirmation message.
 *
 * A WhatsApp button can only vary the last part of its URL, and Meta will
 * not take %, # or $ there - so the cart permalink, which is full of all
 * three, cannot go in the button. The button carries the order's own id:
 *
 *     https://zakdor.com/apps/track/pay/<id>
 *
 * and when it lands here the real cart link is built and the customer is
 * sent straight on to it, items and discount already in place.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  const id = String(params.id ?? "");
  const home = `https://${domain ?? ""}/`;

  if (!domain || !id) return new Response(null, { status: 302, headers: { Location: home } });

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return new Response(null, { status: 302, headers: { Location: home } });

  const order = await db.orderRecord.findFirst({ where: { id, shopId: shop.id } });

  // Already cancelled, or nothing to offer: the shop is a better place to
  // land than a cart that would only confuse.
  const to = order && !order.cancelledAt
    ? (await payUrl({ shop, order, domain }).catch(() => "")) || home
    : home;

  console.log(`[pay-link] ${id} -> ${to === home ? "shop" : "cart"}`);
  return new Response(null, { status: 302, headers: { Location: to } });
};
