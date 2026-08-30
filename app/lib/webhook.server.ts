import db from "../db.server";

/**
 * Shopify har webhook ko retry karta hai, aur ek hi event do-teen baar
 * pahunch sakta hai. Har delivery ke saath ek unique id header me aati hai.
 * Use ek table me likh dena hi sabse sasta idempotency hai.
 *
 * Pehli baar aane par true, har repeat par false.
 *
 * IMPORTANT: ise authenticate.webhook() ke BAAD call karna. Body wahan
 * padh li jaati hai, par headers baad me bhi mil jaate hain.
 */
export async function firstDelivery(
  request: Request,
  topic: string,
  shop: string,
): Promise<boolean> {
  const id = request.headers.get("x-shopify-webhook-id");
  if (!id) return true; // dedupe nahi kar sakte, aage jaane do

  try {
    await db.webhookEvent.create({ data: { id, topic, shop } });
    return true;
  } catch {
    // unique constraint -> ye delivery pehle hi handle ho chuki hai
    return false;
  }
}

/** Shop ki row le aao, na ho to bana do. */
export async function ensureShop(domain: string) {
  return db.shop.upsert({
    where: { domain },
    update: {},
    create: { domain },
  });
}

/**
 * Bharat ke numbers ko E.164 me badalta hai, jo WhatsApp Cloud API maangta hai.
 *
 *   "9876543210"        -> "919876543210"
 *   "+91 98765 43210"   -> "919876543210"
 *   "098765-43210"      -> "919876543210"
 *
 * Number bekaar lage to null - taaki galat number pe message na jaaye.
 */
export function toE164(raw?: string | null, cc = "91"): string | null {
  if (!raw) return null;

  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;

  // "00" prefix wala international format
  if (d.startsWith("00")) d = d.slice(2);

  // 10 digit local number -> country code lagao
  if (d.length === 10) return cc + d;

  // 11 digit jo 0 se shuru ho -> STD ka 0 hatao
  if (d.length === 11 && d.startsWith("0")) return cc + d.slice(1);

  // pehle se country code ke saath
  if (d.length >= 11 && d.length <= 15) return d;

  return null;
}

/**
 * Order ka phone dhoondho.
 *
 * Kram jaan-boojh ke aisa hai: SHIPPING ADDRESS pehle.
 *
 * Customer ke profile me purana ya doosre desh ka number pada ho sakta hai -
 * jaise koi customer videsh me rehta ho par parcel India me bhej raha ho.
 * Delivery ka message us insaan tak jaana chahiye jo parcel lene wala hai,
 * isliye shipping address ka number sabse pehle dekhte hain.
 */
export function pickPhone(order: any): string | null {
  return toE164(
    order?.shipping_address?.phone ||
      order?.phone ||
      order?.customer?.phone ||
      order?.billing_address?.phone ||
      null,
  );
}

/** Customer ka pehla naam - message me "Hi Rahul" ke liye. */
export function pickName(order: any): string {
  const n =
    order?.shipping_address?.first_name ||
    order?.customer?.first_name ||
    order?.billing_address?.first_name ||
    "";
  return String(n).trim();
}

/**
 * COD hai ya nahi.
 *
 * Ye check sabse zaroori hai. COD order bhi orders/paid firing karta hai -
 * par HAFTON BAAD, jab courier cash jama karta hai. Bina is guard ke
 * customer ko "Payment received" 3 hafte baad jaayega aur spam lagega.
 *
 * DHYAN: "manual" gateway ko COD nahi maanate. Shopify wo naam tab bhi
 * likhta hai jab dukaandaar khud kisi order ko "Mark as paid" karta hai -
 * aur wo COD nahi hota. Sirf saaf-saaf COD wale naam pakadte hain.
 */
export function isCodOrder(order: any): boolean {
  const names: string[] = order?.payment_gateway_names || [];
  return names.some((g) =>
    /cash[\s_-]?on[\s_-]?delivery|(^|[^a-z])cod([^a-z]|$)/i.test(String(g)),
  );
}

/**
 * Order ki row banao ya update karo, payload se.
 *
 * Ye ek hi jagah is liye hai kyunki orders/create aur orders/paid EK HI
 * SECOND me aa sakte hain. Agar paid pehle pahunch gaya aur order abhi
 * database me likha hi nahi tha, to "COD hai kya?" ka jawab "pata nahi"
 * aata tha aur guard fail ho jaata tha.
 *
 * Ab dono handler yahi function bulate hain, isliye jo bhi pehle
 * pahunche - row bhi ban jaati hai aur isCod bhi sahi bharta hai.
 */
export async function upsertOrder(shopId: string, order: any) {
  const cod = isCodOrder(order);
  const phone = pickPhone(order);
  const name = pickName(order);
  const orderNumber = order.name ?? `#${order.order_number ?? ""}`;

  const common = {
    orderNumber,
    customerName: name || null,
    phone,
    email: order.email ?? null,
    totalPrice: order.total_price ?? null,
    currency: order.currency ?? null,
    financial: order.financial_status ?? null,
    gateway: (order.payment_gateway_names ?? []).join(", ") || null,
    isCod: cod,
  };

  return db.orderRecord.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId: String(order.id) } },
    update: common,
    create: { shopId, shopifyId: String(order.id), ...common },
  });
}
