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
    buttonParam: def.button ? def.button(vars) : null,
  });

  if (res.ok) {
    await db.messageLog.update({
      where: { id: logId },
      data: { status: "sent", providerId: res.id, sentAt: new Date(), error: null },
    });
    console.log(`[notify] sent ${event} -> ${to}`);
    return;
  }

  // No point retrying a permanent error - the number is wrong, or the
  // template does not exist, or the customer has blocked us.
  await db.messageLog.update({
    where: { id: logId },
    data: { status: res.permanent ? "failed" : "queued", error: res.error },
  });
  console.log(`[notify] ${res.permanent ? "FAILED" : "retry later"} ${event} -> ${to}: ${res.error}`);
}

/** Whether the merchant has kept this event switched ON. */
export function eventEnabled(shop: any, event: string): boolean {
  const map: Record<string, string> = {
    order_created: "onOrderCreate",
    cod_confirm: "codConfirm",
    cod_reminder: "codConfirm",
    cod_confirmed: "codConfirm",
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
  return key ? Boolean(shop[key]) : true;
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
