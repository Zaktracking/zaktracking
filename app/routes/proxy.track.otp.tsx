/**
 * The storefront's way in and out of the OTP check.
 *
 *   POST /apps/track/otp   { intent: "send",   phone }
 *   POST /apps/track/otp   { intent: "verify", phone, code }
 *
 * It sits under the app proxy, so Shopify signs every request and
 * authenticate.public.appProxy rejects anything that is not really from
 * this store. No default export - nothing is rendered here, only JSON.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy } from "../lib/proxy.server";
import { toE164 } from "../lib/webhook.server";
import { requestOtp, verifyOtp } from "../lib/otp.server";

/** A GET here means someone typed the address in. Nothing to see. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: false, reason: "POST only" }, { status: 405 });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  if (!domain) return Response.json({ ok: false, reason: "Unknown shop" }, { status: 400 });

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return Response.json({ ok: false, reason: "Unknown shop" }, { status: 400 });

  // Accept a form post or JSON, so the storefront can use whichever is
  // easier without this route caring.
  let data: Record<string, string> = {};
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    data = (await request.json().catch(() => ({}))) as any;
  } else {
    const fd = await request.formData().catch(() => null);
    if (fd) for (const [k, v] of fd.entries()) data[k] = String(v);
  }

  const intent = String(data.intent || "");
  const phone = toE164(String(data.phone || ""));

  if (!phone) {
    return Response.json({ ok: false, reason: "Enter a valid 10-digit mobile number" });
  }

  if (intent === "send") {
    const res = await requestOtp(shop.id, phone);
    return Response.json(res);
  }

  if (intent === "verify") {
    const res = await verifyOtp(shop.id, phone, String(data.code || ""));
    return Response.json(res);
  }

  return Response.json({ ok: false, reason: "Unknown request" }, { status: 400 });
};
