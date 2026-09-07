import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, eventEnabled } from "../lib/notify.server";
import { blankVars, itemLine, etaDate } from "../lib/templates.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);
  const rec = await upsertOrder(s.id, order);

  const f = (order.fulfillments ?? []).find(
    (x: any) => x.tracking_number || x.tracking_url,
  );

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.order = rec.orderNumber;
  v.item = itemLine(order);
  v.courier = f?.tracking_company || "our courier partner";
  v.tracking = f?.tracking_number || "";
  // Four working days from the hand-over, as "arriving by 12 September".
  v.eta = etaDate(new Date(), 4);

  if (!eventEnabled(s, "shipped")) return new Response();

  await queueMessage({
    shopId: s.id,
    orderId: rec.id,
    event: "shipped",
    to: rec.phone,
    vars: v,
  });

  return new Response();
};
