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

  // First choice is Shopify's own recovery URL - it reopens the checkout
  // with the address already typed in. But Shopify leaves that empty on
  // plenty of checkouts, and the customer was landing on the shop front
  // wondering where their cart went. So second choice is a cart permalink
  // built from the variant ids we wrote down: /cart/<id>:<qty>,... puts
  // the same items back and goes straight to the cart.
  //
  // The shop front is only for a cart so old that we kept no lines at all.
  const to =
    cart?.recoverUrl ||
    (cart?.cartItems
      ? `https://${domain}/cart/${cart.cartItems}`
      : `https://${domain}/collections/all`);

  console.log(
    `[cart-link] ${token} -> ${cart?.recoverUrl ? "recovery" : cart?.cartItems ? "permalink" : "shop"}`,
  );
  return new Response(null, { status: 302, headers: { Location: to } });
};
