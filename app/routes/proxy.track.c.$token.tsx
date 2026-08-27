import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy } from "../lib/proxy.server";

/**
 * Short link that reopens an abandoned cart.
 *
 * The full Shopify recovery URL cannot go into a WhatsApp button - it is
 * very long and different for every customer. A template can only vary
 * the last part of a URL. So the button carries this instead:
 *
 *     https://zakdor.com/apps/track/c/<token>
 *
 * and when it lands here we look up that shopper's real recovery URL and
 * send them on - the cart opens just as it was, everything still in it.
 *
 * Sending them straight to /cart is no use - that opens a new empty cart.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  const token = String(params.token ?? "");

  if (!domain || !token) return Response.redirect(`https://${domain ?? ""}/`, 302);

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return Response.redirect(`https://${domain}/`, 302);

  const cart = await db.abandonedCart.findUnique({
    where: { shopId_token: { shopId: shop.id, token } },
  });

  // The link has expired or the order already went through - better to
  // open the shop than to send the customer to an empty cart.
  const to = cart?.recoverUrl || `https://${domain}/collections/all`;

  console.log(`[cart-link] ${token} -> ${cart?.recoverUrl ? "recovery" : "shop"}`);
  return new Response(null, { status: 302, headers: { Location: to } });
};
