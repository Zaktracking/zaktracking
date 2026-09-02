import db from "../db.server";
import { itemLine, shortAddress, orderTotal, amountDue } from "./templates.server";

/**
 * Shopify retries every webhook, and the same event can arrive two or three
 * times. Every delivery carries a unique id in a header. Writing that into a
 * table is the cheapest idempotency there is.
 *
 * True the first time it arrives, false on every repeat.
 *
 * IMPORTANT: call this AFTER authenticate.webhook(). The body is read there,
 * but the headers are still available afterwards.
 */
export async function firstDelivery(
  request: Request,
  topic: string,
  shop: string,
): Promise<boolean> {
  const id = request.headers.get("x-shopify-webhook-id");
  if (!id) return true; // cannot dedupe, let it through

  try {
    await db.webhookEvent.create({ data: { id, topic, shop } });
    return true;
  } catch {
    // unique constraint -> this delivery has already been handled
    return false;
  }
}

/** Fetch the shop's row, create it if there is none. */
export async function ensureShop(domain: string) {
  return db.shop.upsert({
    where: { domain },
    update: {},
    create: { domain },
  });
}

/**
 * Converts Indian numbers to E.164, which the WhatsApp Cloud API demands.
 *
 *   "9876543210"        -> "919876543210"
 *   "+91 98765 43210"   -> "919876543210"
 *   "098765-43210"      -> "919876543210"
 *
 * If the number looks unusable, null - so no message goes to a wrong one.
 */
export function toE164(raw?: string | null, cc = "91"): string | null {
  if (!raw) return null;

  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;

  // international format with a "00" prefix
  if (d.startsWith("00")) d = d.slice(2);

  // 10 digit local number -> add the country code
  if (d.length === 10) return cc + d;

  // 11 digits starting with 0 -> strip the STD 0
  if (d.length === 11 && d.startsWith("0")) return cc + d.slice(1);

  // already carries a country code
  if (d.length >= 11 && d.length <= 15) return d;

  return null;
}

/**
 * Find the order's phone number.
 *
 * The order here is deliberate: SHIPPING ADDRESS first.
 *
 * The customer profile may hold an old number, or one from another country -
 * say a customer who lives abroad but is sending the parcel to India.
 * The delivery message has to reach the person who will receive the parcel,
 * so we look at the shipping address number first.
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

/** The customer's first name - for "Hi Rahul" in the message. */
export function pickName(order: any): string {
  const n =
    order?.shipping_address?.first_name ||
    order?.customer?.first_name ||
    order?.billing_address?.first_name ||
    "";
  return String(n).trim();
}

/**
 * Whether this is COD.
 *
 * This check matters most. A COD order fires orders/paid too - but WEEKS
 * LATER, when the courier deposits the cash. Without this guard the
 * customer gets "Payment received" 3 weeks on and it reads as spam.
 *
 * NOTE: we do not treat the "manual" gateway as COD. Shopify writes that
 * name down even when the shopkeeper marks an order "Mark as paid" himself -
 * and that is not COD. We only catch names that plainly say COD.
 */
export function isCodOrder(order: any): boolean {
  const names: string[] = order?.payment_gateway_names || [];
  if (
    names.some((g) =>
      /cash[\s_-]?on[\s_-]?delivery|(^|[^a-z])cod([^a-z]|$)/i.test(String(g)),
    )
  ) {
    return true;
  }

  // Partial-payment COD apps tag the order themselves - COD King writes
  // "COD-Verified". That tag is a plain statement that cash is due.
  if (/(^|[^a-z])cod([^a-z]|$)/i.test(String(order?.tags ?? ""))) return true;

  // And the case that caught us out: those apps create the order with NO
  // gateway at all and simply leave the balance unpaid, which Shopify shows
  // as "pending" or "partially paid". No gateway name to match, but money
  // still has to be collected at the door - and that is what COD means for
  // every message this app sends.
  //
  // A prepaid order waiting on its gateway looks the same for a few seconds.
  // We accept that: asking such a customer to confirm is harmless, while
  // treating a real COD order as prepaid sends "payment received" for money
  // that was never paid.
  const status = String(order?.financial_status ?? "").toLowerCase();
  const outstanding = Number(order?.total_outstanding ?? 0);
  if (
    Number.isFinite(outstanding) &&
    outstanding > 0 &&
    (status === "pending" || status === "partially_paid")
  ) {
    return true;
  }

  return false;
}

/**
 * Create or update the order row from the payload.
 *
 * This sits in one place because orders/create and orders/paid can arrive
 * in the SAME SECOND. If paid got there first and the order had not been
 * written to the database yet, the answer to "is this COD?" came back as
 * "no idea" and the guard failed.
 *
 * Both handlers now call this same function, so whichever gets there
 * first - the row gets created and isCod gets filled in correctly.
 */
export async function upsertOrder(shopId: string, order: any) {
  const cod = isCodOrder(order);
  const phone = pickPhone(order);
  const name = pickName(order);
  const orderNumber = order.name ?? `#${order.order_number ?? ""}`;

  const addr = order?.shipping_address ?? order?.billing_address ?? {};

  const common = {
    orderNumber,
    customerName: name || null,
    phone,
    email: order.email ?? null,
    totalPrice: orderTotal(order),
    // What is still to be collected at the door. On a partial-payment COD
    // order this is smaller than the total, and it is the only figure the
    // customer should ever be asked for.
    outstanding: amountDue(order),
    currency: order.currency ?? null,
    financial: order.financial_status ?? null,
    gateway: (order.payment_gateway_names ?? []).join(", ") || null,
    isCod: cod,

    // These three get filled in right here because when the courier update
    // arrives we do not have Shopify's payload at all - only the tracking
    // number. Then "Portable Blender + 1 more item" would come from nowhere.
    itemLine: itemLine(order),
    city: addr?.city ?? null,
    address: shortAddress(order),
  };

  return db.orderRecord.upsert({
    where: { shopId_shopifyId: { shopId, shopifyId: String(order.id) } },
    update: common,
    create: { shopId, shopifyId: String(order.id), ...common },
  });
}
