/**
 * Razorpay, spoken to directly.
 *
 * Paying online used to mean leaving the popup for Shopify's checkout and
 * coming back to Shopify's thank-you page. With the shop's own Razorpay
 * keys the popup opens Razorpay's checkout itself, and once the money is
 * in, the order is written by this app - the same way a Cash on Delivery
 * order is - and the customer lands on the app's own confirmation.
 *
 * Only three calls are needed, and they are all here:
 *   - open an order (the amount is fixed here, on the server, so the
 *     browser can never change what is charged)
 *   - prove a payment is real (the signature Razorpay hands the browser)
 *   - read a payment or an order back, for the cron's second look
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.razorpay.com/v1";

/** Both keys in, and the popup takes the money itself. */
export function rzpReady(shop: any): boolean {
  return Boolean(shop?.rzpKeyId && shop?.rzpKeySecret);
}

async function call(shop: any, path: string, body?: any): Promise<any> {
  const auth = Buffer.from(`${shop.rzpKeyId}:${shop.rzpKeySecret}`).toString("base64");
  const res = await fetch(API + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = json?.error?.description || `HTTP ${res.status}`;
    throw new Error(why);
  }
  return json;
}

/**
 * A Razorpay order for exactly this many paise. Its id is what the
 * checkout opens with; the amount rides inside it and cannot be edited
 * from the page.
 */
export async function createRzpOrder(
  shop: any,
  paise: number,
  receipt: string,
  notes: Record<string, string>,
): Promise<{ id: string; amount: number }> {
  const o = await call(shop, "/orders", {
    amount: Math.round(paise),
    currency: "INR",
    receipt: receipt.slice(0, 40),
    notes,
  });
  if (!o?.id) throw new Error("Razorpay did not return an order");
  return { id: String(o.id), amount: Number(o.amount) };
}

/**
 * The proof that a payment the browser reports really happened:
 * HMAC-SHA256 of "<order id>|<payment id>" with the key secret, which only
 * Razorpay and this server hold.
 */
export function signatureOk(shop: any, orderId: string, paymentId: string, signature: string): boolean {
  if (!orderId || !paymentId || !signature) return false;
  const want = createHmac("sha256", String(shop.rzpKeySecret)).update(`${orderId}|${paymentId}`).digest("hex");
  const a = Buffer.from(want, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type RzpPayment = {
  id: string;
  orderId: string;
  amount: number;   // paise
  currency: string;
  status: string;   // created | authorized | captured | refunded | failed
  method: string;
};

function shape(p: any): RzpPayment {
  return {
    id: String(p?.id ?? ""),
    orderId: String(p?.order_id ?? ""),
    amount: Number(p?.amount) || 0,
    currency: String(p?.currency ?? ""),
    status: String(p?.status ?? ""),
    method: String(p?.method ?? ""),
  };
}

/** One payment, as Razorpay sees it now. */
export async function fetchPayment(shop: any, paymentId: string): Promise<RzpPayment> {
  return shape(await call(shop, `/payments/${encodeURIComponent(paymentId)}`));
}

/** Every payment attempt made against an order - the cron's way of finding
 *  money that arrived while nobody was looking. */
export async function paymentsOf(shop: any, rzpOrder: string): Promise<RzpPayment[]> {
  const j = await call(shop, `/orders/${encodeURIComponent(rzpOrder)}/payments`);
  return (j?.items ?? []).map(shape);
}

/**
 * Makes sure the money is actually taken. A Razorpay account set to capture
 * by hand leaves a payment "authorized" - held on the card, not moved - and
 * released after a few days if nobody captures it. So an authorized payment
 * is captured here, for the exact amount, before an order is ever written.
 */
export async function ensureCaptured(shop: any, p: RzpPayment, paise: number): Promise<RzpPayment> {
  if (p.status === "captured") return p;
  if (p.status !== "authorized") return p;
  const c = await call(shop, `/payments/${encodeURIComponent(p.id)}/capture`, {
    amount: Math.round(paise),
    currency: "INR",
  });
  return shape(c);
}
