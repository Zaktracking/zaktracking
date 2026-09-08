import db from "../db.server";
import { sendTemplate } from "./whatsapp.server";
import { EVENTS, preview, type Vars } from "./templates.server";

/**
 * Queues a message and tries to send it right away.
 *
 * Duplicates are stopped by the database, not by code: MessageLog has a
 * unique([orderId, event, channel]) constraint. So the same customer never
 * gets "your order has shipped" twice, even if the webhook arrives
 * five times.
 *
 * The row is created first, sending happens after. The other way round, two
 * webhooks arriving at once would both send and we would find out too late.
 */
export async function queueMessage(opts: {
  shopId: string;
  orderId?: string | null;
  event: string;
  to: string | null;
  vars: Vars;
  channel?: "whatsapp" | "sms";
}) {
  const channel = opts.channel ?? "whatsapp";
  const def = EVENTS[opts.event];

  if (!def) {
    console.log(`[notify] no template named ${opts.event}`);
    return null;
  }
  if (!opts.to) {
    console.log(`[notify] skip ${opts.event}: no phone number`);
    return null;
  }

  // Every message carries "Reply STOP to opt out" in its footer.
  // Once someone sends STOP, nothing more goes out - not even order updates.
  if (await isOptedOut(opts.shopId, opts.to)) {
    console.log(`[notify] skip ${opts.event}: ${opts.to} has opted out with STOP`);
    return null;
  }

  let row;
  try {
    row = await db.messageLog.create({
      data: {
        shopId: opts.shopId,
        orderId: opts.orderId ?? null,
        channel,
        event: opts.event,
        to: opts.to,
        body: preview(opts.event, opts.vars),
        vars: JSON.stringify(opts.vars),
        status: "queued",
      },
    });
  } catch {
    console.log(`[notify] duplicate ${opts.event}, skipped`);
    return null;
  }

  await deliver(row.id, opts.shopId, opts.event, opts.to, opts.vars);
  return row;
}

/**
 * The actual send. It is a separate function so that "resend" on the admin
 * page can call it too.
 */
export async function deliver(
  logId: string,
  shopId: string,
  event: string,
  to: string,
  vars: Vars,
) {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  const def = EVENTS[event];
  if (!shop || !def) return;

  // The credentials have not been filled in yet - the message stays queued.
  // This is not an error, so the status stays "queued".
  if (!shop.waEnabled || !shop.waToken || !shop.waPhoneNumberId) {
    console.log(`[notify] queued ${event} -> ${to} (WhatsApp is not set up yet)`);
    return;
  }

  const res = await sendTemplate({
    phoneNumberId: shop.waPhoneNumberId,
    token: shop.waToken,
    // Passing the WABA id lets the sender look up the language the template
    // is actually filed under instead of assuming English.
    wabaId: shop.waWabaId,
    to,
    template: def.template,
    params: def.params(vars),
    altParams: def.old ? def.old(vars) : null,
    buttonParam: def.button ? def.button(vars) : null,
    couponParam: def.coupon ? def.coupon(vars) : null,
  });

  if (res.ok) {
    await db.messageLog.update({
      where: { id: logId },
      data: {
        status: "sent",
        providerId: res.id,
        sentAt: new Date(),
        error: null,
        attempts: { increment: 1 },
        nextTryAt: null,
      },
    });
    console.log(`[notify] sent ${event} -> ${to}`);
    return;
  }

  // No point retrying a permanent error - the number is wrong, or the
  // template does not exist, or the customer has blocked us.
  if (res.permanent) {
    await db.messageLog.update({
      where: { id: logId },
      data: { status: "failed", error: res.error, attempts: { increment: 1 }, nextTryAt: null },
    });
    console.log(`[notify] FAILED ${event} -> ${to}: ${res.error}`);
    return;
  }

  // Everything else passes: Meta having a bad minute, this host waking up,
  // the network. Those are worth another go - which until now nothing ever
  // gave them. The row said "queued", the log said "retry later", and no
  // part of the app ever came back for it.
  const row = await db.messageLog.findUnique({ where: { id: logId } });
  const attempts = (row?.attempts ?? 0) + 1;
  const gap = BACKOFF_MIN[attempts - 1];
  const age = Date.now() - (row?.createdAt ?? new Date()).getTime();

  // Out of tries, or so old that arriving would be worse than staying
  // away - a cart reminder eight hours late is not a reminder.
  if (gap == null || age + gap * 60_000 > retryWindowMs(event)) {
    await db.messageLog.update({
      where: { id: logId },
      data: {
        status: "failed",
        error: `${res.error} - given up after ${attempts}`,
        attempts,
        nextTryAt: null,
      },
    });
    console.log(`[notify] gave up on ${event} -> ${to} after ${attempts}: ${res.error}`);
    return;
  }

  await db.messageLog.update({
    where: { id: logId },
    data: { status: "queued", error: res.error, attempts, nextTryAt: new Date(Date.now() + gap * 60_000) },
  });
  console.log(`[notify] ${event} -> ${to} failed (${res.error}) - again in ${gap} min`);
}

/**
 * Growing gaps between tries, in minutes. Five goes over about nine hours:
 * long enough to sit out anything short, short enough that a message still
 * arrives while it means something. Running out of this list is the end.
 */
const BACKOFF_MIN = [5, 15, 45, 120, 360];

/**
 * How long a message is worth chasing, counted from when it was made.
 *
 * A cart reminder is a moment - it belongs to the hour the cart was left,
 * and one that turns up the next morning is litter. An order confirmation
 * or a refund is worth having whenever it lands.
 */
function retryWindowMs(event: string): number {
  return event.startsWith("abandoned_") ? 3 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

/**
 * The messages that failed for a passing reason and are due another go.
 *
 * The clock job calls this. Nothing used to, which is how four cart
 * reminders sat in the queue for two days without a soul noticing.
 */
export async function sweepQueued(limit = 50): Promise<number> {
  let due;
  try {
    due = await db.messageLog.findMany({
      where: { status: "queued", nextTryAt: { not: null, lte: new Date() } },
      orderBy: { nextTryAt: "asc" },
      take: limit,
    });
  } catch (e: any) {
    console.log(`[notify] could not read the retry queue: ${e?.message ?? e}`);
    return 0;
  }

  let sent = 0;
  for (const row of due) {
    let vars: Vars;
    try {
      vars = JSON.parse(row.vars ?? "");
    } catch {
      // Written before this column existed, so there is nothing to send
      // from. Close it rather than read it again every ten minutes.
      await db.messageLog.update({
        where: { id: row.id },
        data: { status: "failed", error: "no saved values to send again from", nextTryAt: null },
      });
      continue;
    }

    await deliver(row.id, row.shopId, row.event, row.to, vars);
    const after = await db.messageLog.findUnique({ where: { id: row.id } });
    if (after?.status === "sent") sent++;
  }

  if (due.length) console.log(`[notify] retried ${due.length}, ${sent} went`);
  return sent;
}

/** Whether the merchant has kept this event switched ON. */
export function eventEnabled(shop: any, event: string): boolean {
  const map: Record<string, string> = {
    order_created: "onOrderCreate",
    // codConfirm is the whole COD flow's master switch; each of its three
    // messages has a switch of its own besides, so the ask, the reminder
    // and the confirmation can be turned off one at a time.
    cod_confirm: "onCodConfirm",
    cod_reminder: "onCodReminder",
    cod_confirmed: "onCodConfirmed",
    order_paid: "onOrderPaid",
    shipped: "onFulfilled",
    in_transit: "onInTransit",
    out_for_delivery: "onOutForDelivery",
    delivery_failed: "onOutForDelivery",
    rto_alert: "onOutForDelivery",
    delivered: "onDelivered",
    cancelled: "onCancelled",
    refunded: "onCancelled",
    abandoned_1: "onAbandoned",
    abandoned_2: "onAbandoned",
  };
  const key = map[event];
  if (!key) return true;
  if (key.startsWith("onCod") && !shop.codConfirm) return false;
  return Boolean(shop[key]);
}

/**
 * Honouring STOP.
 *
 * Every message carries "Reply STOP to opt out" in its footer. That promise
 * is only true if we act on it - WhatsApp does nothing itself, STOP reaches
 * us like any ordinary inbound message.
 */
export async function optOut(shopId: string, phone: string) {
  await db.optOut.upsert({
    where: { shopId_phone: { shopId, phone } },
    update: {},
    create: { shopId, phone },
  });
  console.log(`[notify] ${phone} sent STOP - no further messages`);
}

/** Checked before every single send. */
export async function isOptedOut(shopId: string, phone: string) {
  const row = await db.optOut.findUnique({
    where: { shopId_phone: { shopId, phone } },
  });
  return Boolean(row);
}
