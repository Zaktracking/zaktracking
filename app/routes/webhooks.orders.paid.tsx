import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { firstDelivery, ensureShop, upsertOrder } from "../lib/webhook.server";
import { queueMessage, renderMessage, eventEnabled } from "../lib/notify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (!(await firstDelivery(request, topic, shop))) return new Response();

  const order = payload as any;
  const s = await ensureShop(shop);

  // ---------------------------------------------------------------------
  //  Yahan findUnique ki jagah upsert hai, aur wajah asli hai.
  //
  //  orders/create aur orders/paid ek hi second me aa sakte hain. Pehle
  //  yahan sirf dhoondhte the - aur agar paid pehle pahunch gaya, to order
  //  database me tha hi nahi. Tab "COD hai kya?" ka jawab "pata nahi" aata
  //  tha aur neeche wala guard chup rehta tha.
  //
  //  Ab jo bhi pehle pahunche, row bhi ban jaati hai aur isCod bhi sahi
  //  bhar jaata hai. Race khatam.
  // ---------------------------------------------------------------------
  const rec = await upsertOrder(s.id, order);

  // COD order bhi orders/paid firing karta hai - par HAFTON BAAD, jab
  // courier cash jama karta hai. Us waqt "Payment received" bhejna spam
  // lagta hai, parcel to kab ka mil chuka hota hai.
  if (rec.isCod) {
    console.log(`[orders/paid] ${rec.orderNumber} COD hai, message nahi bheja`);
    return new Response();
  }

  if (!eventEnabled(s, "order_paid")) return new Response();

  const body = await renderMessage(s.id, "order_paid", "whatsapp", {
    name: rec.customerName || "there",
    order: rec.orderNumber,
    amount: `${order.currency ?? ""} ${order.total_price ?? ""}`.trim(),
    link: "",
  });

  if (body) {
    await queueMessage({
      shopId: s.id,
      orderId: rec.id,
      channel: "whatsapp",
      event: "order_paid",
      to: rec.phone,
      body,
    });
  }

  return new Response();
};
