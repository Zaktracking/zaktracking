import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy } from "../lib/proxy.server";

/**
 * "Tell me when it is back."
 *
 * The storefront posts here from a sold-out product. All it leaves behind is
 * a number against a variant; when that variant has stock again the
 * products/update webhook works through the list.
 *
 * Nothing is sent from here, so there is nothing to abuse beyond signing
 * up - and the same number against the same variant is one row, not two.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  if (!domain) return Response.json({ ok: false, reason: "Something went wrong" });

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return Response.json({ ok: false, reason: "Something went wrong" });

  const body = (await request.json().catch(() => ({}))) as any;
  const phone = String(body.phone ?? "").replace(/\D/g, "").slice(-10);
  const variantId = String(body.variant ?? "").replace(/\D/g, "");
  const handle = String(body.handle ?? "").trim().slice(0, 200);
  const title = String(body.title ?? "").trim().slice(0, 200);

  if (phone.length !== 10) {
    return Response.json({ ok: false, reason: "Enter your 10-digit mobile number" });
  }
  if (!variantId || !handle) {
    return Response.json({ ok: false, reason: "Something went wrong. Please reload the page." });
  }

  const to = `91${phone}`;

  // Someone who has sent STOP asked not to hear from us. Take the number,
  // say thank you, and never write the row - refusing out loud would be a
  // way to find out who has opted out.
  const gone = await db.optOut.findUnique({
    where: { shopId_phone: { shopId: shop.id, phone: to } },
  });
  if (gone) return Response.json({ ok: true });

  await db.stockAlert.upsert({
    where: { shopId_phone_variantId: { shopId: shop.id, phone: to, variantId } },
    update: { handle, title, price: body.price ? String(body.price) : null },
    create: {
      shopId: shop.id,
      phone: to,
      variantId,
      handle,
      title,
      price: body.price ? String(body.price) : null,
    },
  });

  return Response.json({ ok: true });
};
