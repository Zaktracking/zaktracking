/**
 * The messages that no webhook can trigger.
 *
 * Three of our approved templates have no moment of their own: nothing in
 * Shopify fires when a COD order has gone unanswered for six hours, or when
 * a parcel was delivered three days ago. The clock has to notice. That is
 * what this file is - it is called from the cron, once every fifteen
 * minutes, and each sweep is written so that running it again changes
 * nothing: MessageLog's unique([orderId, event, channel]) is the lock.
 */

import db from "../db.server";
import { queueMessage, eventEnabled } from "./notify.server";
import { blankVars, amountVar } from "./templates.server";
import { confirmCod } from "./inbound.server";

const HOUR = 60 * 60 * 1000;

/** How long we wait for an answer before nudging once, unless the shop says otherwise. */
const COD_QUIET_HOURS = 6;
/** After this we stop chasing - the order is stale, not undecided. */
const COD_GIVE_UP_HOURS = 48;
/** Long enough to have used the thing, short enough to still care. */
const REVIEW_AFTER_DAYS = 3;
const REVIEW_GIVE_UP_DAYS = 14;

/**
 * A COD order asked for confirmation and got no reply.
 *
 * Only orders that actually received the first message are chased, and only
 * once. An order that was confirmed, declined, cancelled, or is already
 * waiting on a cancellation is left alone.
 */
export async function sweepCodReminders(shop: any): Promise<number> {
  if (!eventEnabled(shop, "cod_reminder")) return 0;

  const orders = await unanswered(shop, quietHours(shop) * HOUR);

  let sent = 0;
  for (const o of orders) {
    const v = blankVars();
    v.name = o.customerName || "there";
    v.order = o.orderNumber;
    v.item = o.itemLine || "your order";
    v.amount = amountVar(o.outstanding || o.totalPrice, o.currency);

    const row = await queueMessage({
      shopId: shop.id,
      orderId: o.id,
      event: "cod_reminder",
      to: o.phone,
      vars: v,
    });
    if (row) sent++;
  }
  return sent;
}

function quietHours(shop: any): number {
  const h = Number(shop?.codReminderHours);
  return Number.isFinite(h) && h > 0 ? h : COD_QUIET_HOURS;
}

/**
 * The COD orders that were asked to confirm at least `after` ms ago and
 * have said nothing since: not confirmed, not declined, not cancelled, not
 * waiting on a cancellation. Only orders that actually received the ask
 * count, and nothing older than the give-up line.
 */
async function unanswered(shop: any, after: number) {
  const now = Date.now();
  const asked = await db.messageLog.findMany({
    where: {
      shopId: shop.id,
      event: "cod_confirm",
      status: "sent",
      sentAt: {
        lte: new Date(now - after),
        gte: new Date(now - COD_GIVE_UP_HOURS * HOUR),
      },
      orderId: { not: null },
    },
    take: 100,
  });
  if (!asked.length) return [];

  return db.orderRecord.findMany({
    where: {
      id: { in: asked.map((m: any) => m.orderId as string) },
      isCod: true,
      codConfirmed: null,
      cancelledAt: null,
      cancelRequestedAt: null,
    },
  });
}

/**
 * Still nothing after the reminder: the order is taken as confirmed.
 *
 * Most people who do not answer still want the parcel - they saw the
 * message and had nothing to add. Cancelling them was losing real orders;
 * shipping them loses only the few who would have refused at the door,
 * and those had two messages and a Cancel button to say so. The wait is
 * counted from the ask: the reminder's hours, then the minutes set on the
 * shop - so a reminder that failed to send cannot leave an order in limbo.
 * No Pay Now offer here: nobody wrote to us, so the window for it is shut.
 */
export async function sweepCodAutoConfirm(shop: any): Promise<number> {
  if (!shop.codConfirm || !shop.autoConfirm || !eventEnabled(shop, "cod_confirm")) return 0;

  const wait = Math.max(1, Number(shop.autoConfirmMin) || 30) * 60 * 1000;
  const orders = await unanswered(shop, quietHours(shop) * HOUR + wait);

  let done = 0;
  for (const o of orders) {
    await confirmCod(shop, o, shop.domain, "silence");
    console.log(`[cod-auto] ${o.orderNumber} confirmed after no reply`);
    done++;
  }
  return done;
}

/**
 * Ask for a review, a few days after the parcel landed.
 *
 * This is a Marketing template, so it costs more than the rest and it is the
 * one people are quickest to report. One per order, never on an order that
 * was cancelled, and never on a delivery older than a fortnight.
 */
export async function sweepReviewRequests(shop: any): Promise<number> {
  if (!eventEnabled(shop, "review")) return 0;

  const now = Date.now();
  const landed = await db.shipment.findMany({
    where: {
      status: "delivered",
      lastEventAt: {
        lte: new Date(now - REVIEW_AFTER_DAYS * 24 * HOUR),
        gte: new Date(now - REVIEW_GIVE_UP_DAYS * 24 * HOUR),
      },
      order: { shopId: shop.id, cancelledAt: null },
    },
    include: { order: true },
    take: 100,
  });

  let sent = 0;
  for (const s of landed) {
    const o = s.order;
    if (!o) continue;

    const v = blankVars();
    v.name = o.customerName || "there";
    v.item = o.itemLine || "your order";
    v.handle = o.handle || "";

    const row = await queueMessage({
      shopId: shop.id,
      orderId: o.id,
      event: "review",
      to: o.phone,
      vars: v,
    });
    if (row) sent++;
  }
  return sent;
}

/**
 * Someone is waiting for a sold-out item to come back.
 *
 * Called from the products/update webhook, which is the only place that
 * knows a variant's stock has moved. notifiedAt is stamped before the send
 * so a webhook arriving twice cannot tell the same person twice.
 */
export async function notifyBackInStock(
  shopId: string,
  variantId: string,
  price: string | null,
): Promise<number> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop || !eventEnabled(shop, "back_in_stock")) return 0;

  const waiting = await db.stockAlert.findMany({
    where: { shopId, variantId, notifiedAt: null },
    take: 200,
  });
  if (!waiting.length) return 0;

  let sent = 0;
  for (const a of waiting) {
    const claimed = await db.stockAlert.updateMany({
      where: { id: a.id, notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
    if (!claimed.count) continue;

    const v = blankVars();
    v.name = "there";
    v.item = a.title;
    v.amount = amountVar(price ?? a.price, "INR");
    v.handle = a.handle;

    const row = await queueMessage({
      shopId,
      event: "back_in_stock",
      to: a.phone,
      vars: v,
    });
    if (row) sent++;
  }
  return sent;
}
