import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy, esc, liquid } from "../lib/proxy.server";
import { payUrl, payLinkExpired, PAY_LINK_HOURS } from "../lib/paynow.server";

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
 *
 * The link is good for PAY_LINK_HOURS after the offer. After that it shows
 * a short note instead of a cart: by then the parcel is on its way, and an
 * online payment now would only race the courier's cash collection.
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

  if (order && !order.cancelledAt && (await payLinkExpired(order.id))) {
    console.log(`[pay-link] ${id} -> expired`);
    return liquid(
      `<div style="max-width:560px;margin:0 auto;padding:60px 18px 90px;text-align:center">` +
        `<h1 style="font-size:24px;margin:0 0 12px">This payment link has expired</h1>` +
        `<p style="font-size:15px;line-height:1.6;opacity:.8;margin:0 0 24px">` +
        `It worked for ${PAY_LINK_HOURS} hours after we sent it. Please pay cash at the door - ` +
        `order ${esc(order.orderNumber)} is confirmed and on its way.</p>` +
        `<a href="/" style="display:inline-block;padding:12px 22px;border-radius:12px;background:#16181d;` +
        `color:#fff;text-decoration:none;font-weight:600">Back to the store</a></div>`,
    );
  }

  // Already cancelled, or nothing to offer: the shop is a better place to
  // land than a cart that would only confuse.
  const to = order && !order.cancelledAt
    ? (await payUrl({ shop, order, domain }).catch(() => "")) || home
    : home;

  console.log(`[pay-link] ${id} -> ${to === home ? "shop" : "cart"}`);
  return new Response(null, { status: 302, headers: { Location: to } });
};
