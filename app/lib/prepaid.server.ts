/**
 * Paying online inside the popup, start to finish.
 *
 *   1. start    - the popup says what is being bought and where it goes.
 *                 The price is worked out HERE, from Shopify's own prices
 *                 and the real discount codes, and a Razorpay order is
 *                 opened for exactly that. Everything the Shopify order
 *                 will need is written down beside it first.
 *   2. confirm  - Razorpay hands the browser a signed receipt; the browser
 *                 hands it to us. Signature checked, money confirmed taken,
 *                 the Shopify order is written as paid.
 *   3. sweep    - the cron's second look. A phone that lost its connection
 *                 the moment after paying never sends step 2. Razorpay is
 *                 asked which orders were paid, and any without a Shopify
 *                 order yet gets one - within ten minutes, not never.
 *
 * The order is never written before the money is in, so an abandoned
 * payment leaves nothing behind in Shopify - only a row here that expires
 * on its own.
 */

import db from "../db.server";
import {
  variantInfo, discountValue, createPaidOrder,
  type BuyerInput, type BuyerLine,
} from "./order-create.server";
import { prepaidDeal } from "./paynow.server";
import { sendMetaPurchase } from "./meta.server";
import {
  rzpReady, createRzpOrder, fetchPayment, paymentsOf, ensureCaptured, signatureOk,
  type RzpPayment,
} from "./razorpay.server";

/** How long a started-but-unpaid payment is still worth looking at. */
const LIVE_HOURS = 48;

type Coupon = { code: string; claimed: number } | null;

/**
 * What this order costs to pay online: Shopify's prices, the shopper's own
 * code if it is real, and the pay-online saving on top - the same figures
 * the popup already shows, but worked out where the browser cannot touch
 * them.
 */
export async function quotePrepaid(domain: string, shop: any, items: BuyerLine[], coupon: Coupon) {
  let subtotal = 0, count = 0;
  const names: string[] = [];
  for (const l of items) {
    const v = await variantInfo(domain, l.variantId);
    if (!v) return { ok: false as const, reason: "One of the products could not be found." };
    if (!v.available) return { ok: false as const, reason: `${v.productTitle} is out of stock right now.` };
    subtotal += (Number(v.price) || 0) * l.quantity;
    count += l.quantity;
    names.push(v.productTitle);
  }
  subtotal = Math.round(subtotal * 100) / 100;
  if (subtotal <= 0) return { ok: false as const, reason: "There is nothing to pay for." };

  const own = coupon?.code ? await discountValue(domain, coupon.code, subtotal, coupon.claimed) : null;
  const deal = prepaidDeal(shop, count);

  // The two savings ride on the order as one discount line, named for both,
  // and never more than the goods themselves.
  const amount = Math.min(subtotal, Math.round(((own?.amount ?? 0) + deal.off) * 100) / 100);
  const code = own ? `${own.code} + ${deal.code}` : deal.code;
  const total = Math.round((subtotal - amount) * 100) / 100;
  if (total < 1) return { ok: false as const, reason: "This order is covered by the discount - choose Cash on Delivery." };

  const first = names[0] || "your order";
  const description = names.length > 1 ? `${first} + ${names.length - 1} more` : first;

  return {
    ok: true as const,
    subtotal, total, paise: Math.round(total * 100),
    discount: { code, amount },
    description,
  };
}

/**
 * Opens the payment. Returns what the browser needs to show Razorpay's
 * checkout - the key, the order, the amount - and nothing more.
 */
export async function startPayment(domain: string, shop: any, b: BuyerInput, coupon: Coupon) {
  if (!rzpReady(shop)) return { ok: false as const, reason: "Online payment is not set up." };

  const q = await quotePrepaid(domain, shop, b.items, coupon);
  if (!q.ok) return q;

  const input: BuyerInput = { ...b, discount: q.discount };

  let rzp: { id: string; amount: number };
  try {
    rzp = await createRzpOrder(shop, q.paise, `zak-${Date.now().toString(36)}`, {
      phone: b.phone,
      name: `${b.firstName} ${b.lastName}`.trim().slice(0, 100),
    });
  } catch (e: any) {
    console.log(`[pay] razorpay refused the order: ${e?.message ?? e}`);
    return { ok: false as const, reason: "Could not open the payment. Please try again." };
  }

  await db.payment.create({
    data: {
      shopId: shop.id,
      rzpOrder: rzp.id,
      amount: q.paise,
      input: JSON.stringify(input),
    },
  });
  console.log(`[pay] ${rzp.id} opened for ${q.total}`);

  return {
    ok: true as const,
    key: String(shop.rzpKeyId),
    order: rzp.id,
    amount: q.paise,
    total: q.total,
    description: q.description,
  };
}

/**
 * Money confirmed - now the order. Whoever gets here first writes it: the
 * browser a second after paying, or the cron ten minutes later. The row is
 * claimed with a single conditional update, so two arrivals at the same
 * moment can never produce two orders.
 */
export async function finishPayment(shop: any, pay: any, p: RzpPayment) {
  if (pay.status === "ordered") return { ok: true as const, name: String(pay.orderName) };

  if (p.orderId !== pay.rzpOrder) return { ok: false as const, reason: "That payment belongs to a different order." };
  if (p.amount !== pay.amount || (p.currency && p.currency !== "INR")) {
    console.log(`[pay] ${pay.rzpOrder}: paid ${p.amount} ${p.currency}, expected ${pay.amount} INR`);
    return { ok: false as const, reason: "The amount paid does not match the order." };
  }

  try {
    p = await ensureCaptured(shop, p, pay.amount);
  } catch (e: any) {
    console.log(`[pay] ${pay.rzpOrder}: could not capture: ${e?.message ?? e}`);
  }
  if (p.status !== "captured") return { ok: false as const, reason: "The payment has not gone through yet." };

  const claim = await db.payment.updateMany({
    where: { id: pay.id, status: { in: ["pending", "failed"] } },
    data: { status: "creating", rzpPayment: p.id, error: null },
  });

  if (claim.count !== 1) {
    // Someone else is writing it right now. Give them a few seconds.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const now = await db.payment.findUnique({ where: { id: pay.id } });
      if (now?.status === "ordered") return { ok: true as const, name: String(now.orderName) };
      if (now?.status !== "creating") break;
    }
    return { ok: false as const, reason: "Your order is being confirmed. It will reach you on WhatsApp." };
  }

  let input: BuyerInput;
  try {
    input = JSON.parse(pay.input);
  } catch {
    await db.payment.update({ where: { id: pay.id }, data: { status: "failed", error: "unreadable input" } });
    return { ok: false as const, reason: "The order details could not be read." };
  }
  input.note = `Paid online through Razorpay (${p.method || "online"}), phone verified by a one-time code`;

  const res = await createPaidOrder(shop.domain, input, {
    amount: pay.amount / 100,
    paymentId: p.id,
    rzpOrder: pay.rzpOrder,
    method: p.method,
  });

  if (!res.ok) {
    await db.payment.update({ where: { id: pay.id }, data: { status: "failed", error: res.error.slice(0, 500) } });
    console.log(`[pay] ${pay.rzpOrder}: paid but Shopify refused the order - ${res.error}`);
    return { ok: false as const, reason: "Payment received. Your order is being confirmed and will reach you on WhatsApp." };
  }

  await db.payment.update({
    where: { id: pay.id },
    data: { status: "ordered", orderName: res.name, orderId: res.id },
  });

  void sendMetaPurchase({
    value: pay.amount / 100,
    currency: "INR",
    eventId: p.id,
    phone: input.phone,
    email: input.email,
  });

  console.log(`[pay] ${pay.rzpOrder} -> ${res.name}`);
  return { ok: true as const, name: res.name };
}

/** Step 2, from the browser: the signed receipt Razorpay gave it. */
export async function confirmPayment(shop: any, rzpOrder: string, paymentId: string, signature: string) {
  const pay = await db.payment.findUnique({ where: { rzpOrder } });
  if (!pay || pay.shopId !== shop.id) return { ok: false as const, reason: "Unknown payment." };
  if (pay.status === "ordered") return { ok: true as const, name: String(pay.orderName) };

  if (!signatureOk(shop, rzpOrder, paymentId, signature)) {
    console.log(`[pay] ${rzpOrder}: bad signature`);
    return { ok: false as const, reason: "That payment could not be verified." };
  }

  let p: RzpPayment;
  try {
    p = await fetchPayment(shop, paymentId);
  } catch (e: any) {
    console.log(`[pay] ${rzpOrder}: could not read payment ${paymentId}: ${e?.message ?? e}`);
    return { ok: false as const, reason: "Could not confirm the payment yet." };
  }
  return finishPayment(shop, pay, p);
}

/** Where a payment stands, for a browser that is waiting on it. */
export async function paymentStatus(shop: any, rzpOrder: string) {
  const pay = await db.payment.findUnique({ where: { rzpOrder } });
  if (!pay || pay.shopId !== shop.id) return { ok: false as const, status: "unknown" };
  return { ok: true as const, status: pay.status, name: pay.orderName ?? null };
}

/**
 * Step 3, from the cron. Every payment still without an order is checked
 * against Razorpay; one that was paid gets its order now.
 */
export async function sweepPayments() {
  const now = Date.now();
  const rows = await db.payment.findMany({
    where: {
      status: { in: ["pending", "failed"] },
      createdAt: { gte: new Date(now - LIVE_HOURS * 3600 * 1000) },
      // Not one the browser is busy with this very moment.
      updatedAt: { lte: new Date(now - 90 * 1000) },
    },
    include: { shop: true },
    take: 30,
  });

  let ordered = 0, unpaid = 0;
  for (const pay of rows) {
    if (!rzpReady(pay.shop)) continue;
    let list: RzpPayment[] = [];
    try {
      list = await paymentsOf(pay.shop, pay.rzpOrder);
    } catch (e: any) {
      console.log(`[pay] sweep: could not read ${pay.rzpOrder}: ${e?.message ?? e}`);
      continue;
    }
    const good = list.find((p) => p.status === "captured") || list.find((p) => p.status === "authorized");
    if (!good) { unpaid++; continue; }
    const r = await finishPayment(pay.shop, pay, good);
    if (r.ok) ordered++;
  }
  return { ordered, unpaid };
}

