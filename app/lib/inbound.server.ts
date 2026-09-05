/**
 * What happens when the customer writes back.
 *
 * Until the Callback URL was filled in, every reply simply vanished - a
 * number on the WhatsApp Cloud API cannot be opened in the ordinary
 * WhatsApp Business app, so the webhook is the only way a reply is ever
 * seen. This file is the other end of that webhook.
 *
 * Three things arrive here and matter: STOP, "Confirm order", and
 * "Cancel order".
 */

import db from "../db.server";
import { queueMessage } from "./notify.server";
import { blankVars, etaRange } from "./templates.server";
import { optOut } from "./notify.server";
import { tagOrder, orderState, cancelOrder } from "./orders.server";
import { offerPayNow } from "./paynow.server";

export const TAG_CONFIRMED = "cod-confirmed";
export const TAG_CANCEL_REQUESTED = "cod-cancel-requested";
export const TAG_CANCEL_TOO_LATE = "cod-cancel-after-dispatch";

export type Intent = "confirm" | "cancel" | "stop" | "start" | "none";

/**
 * The exact button labels from our templates. A button reply arrives as the
 * label itself, so matching these is exact and safe - unlike free text,
 * where "cancel" could be part of a sentence that means the opposite.
 */
const BUTTON_CONFIRM = ["confirm order", "try again tomorrow", "send it again"];
const BUTTON_CANCEL = ["cancel order", "cancel it"];

/** Short free-text replies people actually send. Whole message only. */
const TEXT_CONFIRM = ["confirm", "confirmed", "yes", "y", "ok", "okay", "haan", "han", "ha"];
const TEXT_CANCEL = ["cancel", "no", "nahi", "na"];
const TEXT_STOP = ["stop", "unsubscribe", "band"];
const TEXT_START = ["start", "resume", "subscribe"];

/** Works out what the customer meant, or "none" if it is an ordinary message. */
export function readIntent(text: string, isButton: boolean): Intent {
  const t = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "");
  if (!t) return "none";

  if (isButton) {
    if (BUTTON_CONFIRM.includes(t)) return "confirm";
    if (BUTTON_CANCEL.includes(t)) return "cancel";
  }

  if (TEXT_STOP.includes(t)) return "stop";
  if (TEXT_START.includes(t)) return "start";
  if (TEXT_CONFIRM.includes(t)) return "confirm";
  if (TEXT_CANCEL.includes(t)) return "cancel";

  return "none";
}

/**
 * The order a reply belongs to.
 *
 * WhatsApp does not tell us which message is being answered, so we take the
 * customer's most recent order. Anything older than thirty days is ignored -
 * a reply that long after the fact is not about that order.
 */
async function recentOrderFor(shopId: string, phone: string) {
  const THIRTY_DAYS = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return db.orderRecord.findFirst({
    where: {
      shopId,
      phone,
      cancelledAt: null,
      createdAt: { gte: THIRTY_DAYS },
    },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Handles one inbound message. Every reply is stored, whether we understood
 * it or not - that store is the merchant's inbox on the admin page.
 */
export async function handleInbound(opts: {
  shopId: string;
  domain: string;
  waMessageId: string;
  from: string;
  text: string;
  kind: string;
}) {
  const isButton = opts.kind === "button" || opts.kind === "interactive";
  const intent = readIntent(opts.text, isButton);

  const order = await recentOrderFor(opts.shopId, opts.from);

  // The unique constraint on waMessageId is what stops a Meta retry from
  // confirming, then cancelling, then confirming the same order again.
  try {
    await db.inboundMessage.create({
      data: {
        shopId: opts.shopId,
        waMessageId: opts.waMessageId,
        from: opts.from,
        text: opts.text.slice(0, 900),
        kind: opts.kind,
        intent,
        orderId: order?.id ?? null,
      },
    });
  } catch {
    console.log(`[inbound] ${opts.waMessageId} already handled, skipping`);
    return { intent: "none" as Intent, duplicate: true };
  }

  console.log(
    `[inbound] ${opts.from} -> "${opts.text}" (${intent})` +
      (order ? ` on ${order.orderNumber}` : " - no recent order"),
  );

  if (intent === "stop") {
    await optOut(opts.shopId, opts.from);
    return { intent, duplicate: false };
  }

  if (intent === "start") {
    await db.optOut
      .delete({ where: { shopId_phone: { shopId: opts.shopId, phone: opts.from } } })
      .catch(() => {});
    console.log(`[inbound] ${opts.from} asked to start again`);
    return { intent, duplicate: false };
  }

  if (!order) return { intent, duplicate: false };

  if (intent === "confirm") {
    await db.orderRecord.update({
      where: { id: order.id },
      // Clearing cancelRequestedAt is the whole point of the grace period:
      // a Cancel pressed by mistake is undone by pressing Confirm, and
      // nothing was ever cancelled in Shopify.
      data: { codConfirmed: true, cancelRequestedAt: null },
    });

    await tagOrder(opts.domain, order.shopifyId, [TAG_CONFIRMED], [TAG_CANCEL_REQUESTED]);

    const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
    if (shop?.codConfirm) {
      const v = blankVars();
      v.name = order.customerName || "there";
      v.order = order.orderNumber;
      v.item = order.itemLine || "your order";
      v.eta = etaRange();

      await queueMessage({
        shopId: opts.shopId,
        orderId: order.id,
        event: "cod_confirmed",
        to: opts.from,
        vars: v,
      });
    }

    // The confirmation has gone; now the offer, as its own plain-text
    // message. The customer wrote to us a moment ago, so the 24-hour
    // window is open and this needs no template - which is the point.
    // Put a saving inside cod_confirmed and Meta reclassifies the whole
    // template as marketing, where it is charged and can be held back by
    // per-user limits. An order confirmation must never be held back.
    await offerPayNow({ shop, order, domain: opts.domain, to: opts.from });

    return { intent, duplicate: false };
  }

  if (intent === "cancel") {
    await db.orderRecord.update({
      where: { id: order.id },
      data: { codConfirmed: false, cancelRequestedAt: new Date() },
    });
    await tagOrder(opts.domain, order.shopifyId, [TAG_CANCEL_REQUESTED], [TAG_CONFIRMED]);
    console.log(
      `[inbound] ${order.orderNumber} cancellation requested - waiting out the grace period`,
    );
    return { intent, duplicate: false };
  }

  return { intent, duplicate: false };
}

/* ------------------------------------------------------------------ */
/*  The grace period                                                   */
/* ------------------------------------------------------------------ */

/**
 * Run from the cron. Cancels the orders whose grace period has run out and
 * where the customer never came back to confirm.
 *
 * Three orders are never cancelled here:
 *   - prepaid ones, because money has already moved and a refund is a
 *     decision, not a side effect
 *   - anything already handed to the courier
 *   - anything the merchant has switched auto-cancel off for
 */
export async function sweepCancelRequests() {
  const out = { cancelled: 0, tooLate: 0, skipped: 0 };

  const shops = await db.shop.findMany({ where: { autoCancel: true } });

  for (const shop of shops) {
    const cutoff = new Date(Date.now() - Math.max(1, shop.cancelGraceMin) * 60 * 1000);

    const due = await db.orderRecord.findMany({
      where: {
        shopId: shop.id,
        cancelledAt: null,
        cancelRequestedAt: { not: null, lte: cutoff },
      },
      take: 25,
    });

    for (const order of due) {
      if (!order.isCod) {
        console.log(
          `[cancel-sweep] ${order.orderNumber} is prepaid - tagged only, not cancelled`,
        );
        await db.orderRecord.update({
          where: { id: order.id },
          data: { cancelRequestedAt: null },
        });
        out.skipped++;
        continue;
      }

      const state = await orderState(shop.domain, order.shopifyId);

      if (!state) {
        out.skipped++;
        continue;
      }

      if (state.cancelledAt) {
        await db.orderRecord.update({
          where: { id: order.id },
          data: { cancelledAt: new Date(state.cancelledAt), cancelRequestedAt: null },
        });
        out.skipped++;
        continue;
      }

      if (state.fulfillment !== "UNFULFILLED") {
        console.log(
          `[cancel-sweep] ${order.orderNumber} has already been dispatched - not cancelling`,
        );
        await tagOrder(shop.domain, order.shopifyId, [TAG_CANCEL_TOO_LATE], []);
        await db.orderRecord.update({
          where: { id: order.id },
          data: { cancelRequestedAt: null },
        });
        out.tooLate++;
        continue;
      }

      const res = await cancelOrder(
        shop.domain,
        order.shopifyId,
        "Cancelled by the customer on WhatsApp",
      );

      if (res.ok) {
        // orders/cancelled fires next and sends the cancellation message,
        // so nothing is queued from here.
        await db.orderRecord.update({
          where: { id: order.id },
          data: { cancelledAt: new Date(), cancelRequestedAt: null },
        });
        out.cancelled++;
      } else {
        out.skipped++;
      }
    }
  }

  return out;
}
