import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { verifySign } from "../lib/track.server";
import { applyByNumber } from "../lib/tracksync.server";

/**
 * The 17TRACK push.
 *
 * The moment the courier scans, 17TRACK POSTs here. This is the route that
 * gets the "out for delivery" message to the customer at the very moment the
 * delivery agent sets out - not two hours later.
 *
 * The URL has to be entered in the 17TRACK dashboard:
 *     https://<app-url>/api/track-webhook
 *
 * Do not skip the signature check. Without it anyone could post
 * "delivered" here and have a false message sent to the customer.
 */

export const loader = async (_: LoaderFunctionArgs) =>
  new Response("ok", { status: 200 });

export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.text();
  const sign =
    request.headers.get("sign") ??
    request.headers.get("x-17track-signature") ??
    request.headers.get("X-17TRACK-SIGNATURE");

  const shops = await db.shop.findMany({ where: { trackApiKey: { not: null } } });
  const shop = shops.find((s) => verifySign(raw, sign, s.trackApiKey!));

  if (!shop) {
    console.log("[track-webhook] signature did not match - ignored");
    return new Response("bad signature", { status: 401 });
  }

  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const event = String(body?.event ?? "");
  // The push sometimes sends { data: {...one...} }, sometimes
  // { data: { accepted: [...] } }. Handle both.
  const d = body?.data ?? {};
  const items: any[] = Array.isArray(d?.accepted)
    ? d.accepted
    : Array.isArray(d)
      ? d
      : d && (d.number || d.track_info)
        ? [d]
        : [];

  let done = 0;
  for (const it of items) {
    const num = String(it?.number ?? it?.track_info?.number ?? "");
    if (!num) continue;
    await applyByNumber(shop.id, num, it);
    done++;
  }

  console.log(`[track-webhook] ${event} - ${done} parcels processed`);
  // 17TRACK needs a 200, otherwise it keeps resending.
  return Response.json({ ok: true, handled: done });
};
