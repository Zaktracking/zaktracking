/**
 * What happens when the customer writes back.
 *
 * Until the Callback URL was filled in, every reply simply vanished - a
 * number on the WhatsApp Cloud API cannot be opened in the ordinary
 * WhatsApp Business app, so the webhook is the only way a reply is ever
 * seen. This file is the other end of that webhook.
 *
 * Every reply gets an answer. A tap on one of our buttons is acted on -
 * Confirm order, Cancel order, Change address, Change phone number, Help.
 * A typed message is read for what it most likely means, and when it means
 * nothing we can act on, the customer is told so plainly and shown a menu,
 * rather than left talking to silence. And whatever a customer says in
 * their own words reaches the merchant's own WhatsApp, because a message
 * only the database has read is a message nobody has read.
 *
 * All of the answers are plain messages, not templates: the customer has
 * just written to us, so the 24-hour service window is open and Meta
 * allows any message inside it.
 */

import db from "../db.server";
import { queueMessage, eventEnabled, optOut, isOptedOut } from "./notify.server";
import { blankVars, etaDate, stamp } from "./templates.server";
import { tagOrder, orderState, cancelOrder, noteOrder } from "./orders.server";
import { offerPayNow } from "./paynow.server";
import { sendTemplate, sendText, sendList } from "./whatsapp.server";

export const TAG_CONFIRMED = "cod-confirmed";
export const TAG_AUTO_CONFIRMED = "cod-auto-confirmed";
export const TAG_CANCEL_REQUESTED = "cod-cancel-requested";
export const TAG_CANCEL_TOO_LATE = "cod-cancel-after-dispatch";
export const TAG_ADDRESS_CHANGE = "address-change-requested";
export const TAG_PHONE_CHANGE = "phone-change-requested";
export const TAG_HELP = "customer-needs-help";

/** The template that carries a customer's words to the merchant's phone. */
export const OWNER_TEMPLATE = "owner_alert";

export type Intent =
  | "confirm" | "cancel" | "stop" | "start"
  | "address" | "phone" | "help" | "track"
  | "address_given" | "phone_given" | "help_given"
  | "hello" | "thanks" | "none";

/**
 * The exact button labels from our templates and from the menu below. A
 * button reply arrives as the label itself, so matching these is exact and
 * safe - unlike free text, where "cancel" could be part of a sentence that
 * means the opposite.
 */
const BUTTON_CONFIRM = ["confirm order", "try again tomorrow", "send it again"];
const BUTTON_CANCEL = ["cancel order", "cancel it"];
const BUTTON_ADDRESS = ["change address", "change my address"];
const BUTTON_PHONE = ["change phone number", "change number", "change phone"];
const BUTTON_HELP = ["help", "something else", "talk to us", "need help"];
const BUTTON_TRACK = ["track order", "track my order", "where is my order"];

/** Short free-text replies people actually send. Whole message only. */
const TEXT_CONFIRM = ["confirm", "confirmed", "yes", "y", "ok", "okay", "haan", "han", "ha", "ji", "ji haan"];
const TEXT_CANCEL = ["cancel", "no", "nahi", "na", "cancel karo", "cancel kar do"];
const TEXT_STOP = ["stop", "unsubscribe", "band"];
const TEXT_START = ["start", "resume", "subscribe"];
const TEXT_HELLO = ["hi", "hii", "hiii", "hello", "hey", "helo", "namaste", "namaskar", "hlo", "good morning", "good evening"];
/** A thank-you, or a message that is only emoji, needs a nod and nothing more. */
const RE_THANKS = /^(thank|thanks|thx|thnx|tq|ty|dhanyavad|dhanyawad|shukriya|great|good|nice|superb|welcome)\b|^[\p{Extended_Pictographic}\s]+$/u;

/**
 * Words that give a typed message away. Address and phone are read before
 * help, and help before track, so "my delivery address is wrong" is an
 * address change and not a tracking question.
 */
const RE_ADDRESS = /\b(address|adress|addres|pata|pincode|pin code|landmark)\b/;
const RE_PHONE = /\b(phone|mobile|mob no|contact no|number|numbr|no\.)\b/;
const RE_HELP = /\b(help|problem|issue|wrong|damage|damaged|broken|missing|complaint|complain|refund|return|replace|replacement|exchange|galat|kharab|tuta|toota|not received|didn'?t receive|never received|fake|defective|leak|leaking|empty|open|used)\b/;
const RE_TRACK = /\b(track|tracking|status|where|kahan|kaha|kab|when|deliver|delivery|delivered|pahunch|pohonch|pahonch|location|reach|aaya|aayega|ayega|kitna|kitne|late|delay|delayed)\b/;

/** Works out what the customer meant, or "none" if it is an ordinary message. */
export function readIntent(text: string, isButton: boolean): Intent {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "").trim();
  if (!t) return "none";

  if (isButton) {
    if (BUTTON_CONFIRM.includes(t)) return "confirm";
    if (BUTTON_CANCEL.includes(t)) return "cancel";
    if (BUTTON_ADDRESS.includes(t)) return "address";
    if (BUTTON_PHONE.includes(t)) return "phone";
    if (BUTTON_HELP.includes(t)) return "help";
    if (BUTTON_TRACK.includes(t)) return "track";
  }

  if (TEXT_STOP.includes(t)) return "stop";
  if (TEXT_START.includes(t)) return "start";
  if (TEXT_CONFIRM.includes(t)) return "confirm";
  if (TEXT_CANCEL.includes(t)) return "cancel";
  if (TEXT_HELLO.includes(t)) return "hello";
  if (RE_THANKS.test(t)) return "thanks";

  if (RE_ADDRESS.test(t)) return "address";
  // "order number Z1001" and "tracking number" are not about a phone
  if (RE_PHONE.test(t) && !/\b(order|track|tracking)\b/.test(t)) return "phone";
  if (RE_HELP.test(t)) return "help";
  if (RE_TRACK.test(t)) return "track";

  return "none";
}

/** The whole-message replies that are never an answer to a question we asked. */
const FIRM: Intent[] = ["confirm", "cancel", "stop", "start", "thanks"];

/** The three questions we ask, and what the answer to each is filed as. */
const ANSWER: Partial<Record<Intent, Intent>> = {
  address: "address_given",
  phone: "phone_given",
  help: "help_given",
};

/**
 * The order a reply belongs to.
 *
 * WhatsApp does not tell us which message is being answered, so we take the
 * customer's most recent order. Anything older than thirty days is ignored -
 * a reply that long after the fact is not about that order. A message that
 * names an order number - "where is Z1005" - gets that order instead, so a
 * customer writing from a second number is not lost either.
 */
async function orderFor(shopId: string, phone: string, text: string) {
  const m = String(text || "").match(/(?:^|\s)#?([zZ]?\d{3,7})\b/);
  if (m) {
    const bare = m[1].replace(/^[zZ]/, "");
    const named = await db.orderRecord.findFirst({
      where: {
        shopId,
        OR: [{ orderNumber: `Z${bare}` }, { orderNumber: `#${bare}` }, { orderNumber: bare }],
      },
      include: { shipments: { orderBy: { createdAt: "desc" } } },
    });
    if (named) return named;
  }

  const THIRTY_DAYS = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return db.orderRecord.findFirst({
    where: {
      shopId,
      phone,
      cancelledAt: null,
      createdAt: { gte: THIRTY_DAYS },
    },
    orderBy: { createdAt: "desc" },
    include: { shipments: { orderBy: { createdAt: "desc" } } },
  });
}

/** The tracking page for an order - the same link the templates carry. */
function trackLink(domain: string, order: any): string {
  const four = String(order.phone ?? "").replace(/\D/g, "").slice(-4);
  return `https://${domain}/apps/track?order=${encodeURIComponent(order.orderNumber)}&pin=${four}`;
}

/** "+91 98765 43210" - the way the merchant will read and dial it. */
function prettyPhone(digits: string): string {
  const d = String(digits).replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return `+${d}`;
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
  let intent = readIntent(opts.text, isButton);

  // What we asked this number last. A reply that comes within a day of
  // "send us the correct address" is the address, whatever it contains -
  // unless it is one of our buttons, or a firm yes/no/stop.
  const DAY = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const prev = await db.inboundMessage.findFirst({
    where: { shopId: opts.shopId, from: opts.from, createdAt: { gte: DAY } },
    // Two replies can land in the same millisecond; the id breaks the tie.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const asked = prev ? ANSWER[prev.intent as Intent] : undefined;
  if (asked && !isButton && !FIRM.includes(intent)) intent = asked;

  const order = await orderFor(opts.shopId, opts.from, opts.text);

  // The unique constraint on waMessageId is what stops a Meta retry from
  // confirming, then cancelling, then confirming the same order again.
  let row;
  try {
    row = await db.inboundMessage.create({
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

  const shop = await db.shop.findUnique({ where: { id: opts.shopId } });
  if (!shop) return { intent, duplicate: false };

  if (intent === "start") {
    await db.optOut
      .delete({ where: { shopId_phone: { shopId: opts.shopId, phone: opts.from } } })
      .catch(() => {});
    console.log(`[inbound] ${opts.from} asked to start again`);
  }

  // Someone who said STOP has asked for silence. Their taps still count -
  // a Confirm confirms, a Cancel cancels - but nothing is written back to
  // them; the one exception is the START that ends the silence.
  const quiet = intent !== "start" && (await isOptedOut(opts.shopId, opts.from));
  const ctx: Ctx = { shop, domain: opts.domain, to: opts.from, order, text: opts.text, row, quiet };

  if (intent === "stop") {
    const already = quiet;
    await optOut(opts.shopId, opts.from);
    if (!already) await reply(ctx, "You will not receive any more messages from us. Reply START if you change your mind.");
    return { intent, duplicate: false };
  }

  if (intent === "start") {
    await reply(ctx, "Welcome back. You will receive updates about your orders again.");
    return { intent, duplicate: false };
  }

  if (!order) {
    await reply(
      ctx,
      "Sorry, we could not find a recent order on this number. If you ordered with a " +
        "different number, please message us from that one - or send us the order number " +
        "(it looks like Z1005) and we will look it up.",
    );
    await tellOwner(ctx, "Could not match the message to an order - asked for the order number");
    return { intent, duplicate: false };
  }

  switch (intent) {
    case "confirm":       await onConfirm(ctx); break;
    case "cancel":        await onCancel(ctx); break;
    case "address":       await onAsk(ctx, "address"); break;
    case "phone":         await onAsk(ctx, "phone"); break;
    case "help":          await onAsk(ctx, "help"); break;
    case "address_given": await onAddress(ctx); break;
    case "phone_given":   await onPhone(ctx); break;
    case "help_given":    await onHelp(ctx); break;
    case "track":         await onTrack(ctx); break;
    case "hello":         await menu(ctx, "Hello! How can we help?"); break;
    case "thanks":        await reply(ctx, "You're welcome. We are here if you need anything else."); break;
    default:              await onUnknown(ctx);
  }

  return { intent, duplicate: false };
}

type Ctx = {
  shop: any;
  domain: string;
  to: string;
  order: any;
  text: string;
  row: { id: string };
  /** the customer has said STOP - act, but do not write back */
  quiet: boolean;
};

/* ------------------------------------------------------------------ */
/*  The answers                                                        */
/* ------------------------------------------------------------------ */

/** One plain message back, remembered on the inbound row. */
async function reply(ctx: Ctx, body: string) {
  const { shop } = ctx;
  if (ctx.quiet || !shop.waEnabled || !shop.waToken || !shop.waPhoneNumberId) return;

  const res = await sendText({ phoneNumberId: shop.waPhoneNumberId, token: shop.waToken, to: ctx.to, body });
  await db.inboundMessage.update({
    where: { id: ctx.row.id },
    data: { reply: (res.ok ? body : `NOT SENT (${res.error}): ${body}`).slice(0, 900) },
  }).catch(() => {});
  if (!res.ok) console.log(`[inbound] reply to ${ctx.to} not sent: ${res.error}`);
}

/**
 * The menu - sent when a message could not be read, so the customer can
 * say it with a tap. Its rows are the same labels the buttons use, and
 * come back through readIntent like any button.
 */
async function menu(ctx: Ctx, lead: string) {
  const { shop } = ctx;
  if (ctx.quiet || !shop.waEnabled || !shop.waToken || !shop.waPhoneNumberId) return;

  const res = await sendList({
    phoneNumberId: shop.waPhoneNumberId,
    token: shop.waToken,
    to: ctx.to,
    body: `${lead}\n\nPlease choose what you need for order ${ctx.order.orderNumber}:`,
    button: "Choose",
    rows: [
      { title: "Track my order", description: "Where the parcel is right now" },
      { title: "Change address", description: "Send a corrected delivery address" },
      { title: "Change phone number", description: "Send the number the courier should call" },
      { title: "Cancel order", description: "Only possible before it is dispatched" },
      { title: "Something else", description: "Tell us what is wrong and we will sort it out" },
    ],
  });

  if (res.ok) {
    await db.inboundMessage.update({ where: { id: ctx.row.id }, data: { reply: `${lead} [menu]` } }).catch(() => {});
    return;
  }
  // A phone that cannot show a list gets the same choices as words.
  await reply(
    ctx,
    `${lead}\n\nReply with one word for order ${ctx.order.orderNumber}: TRACK, ADDRESS, PHONE, CANCEL or HELP.`,
  );
}

/**
 * Confirmed - by a tap, a typed yes, or by silence once the reminder has
 * gone unanswered (the cron calls this then). Shared so both paths mark
 * the order, tag it and send the confirmation the same way.
 */
export async function confirmCod(shop: any, order: any, domain: string, by: "customer" | "silence") {
  await db.orderRecord.update({
    where: { id: order.id },
    // Clearing cancelRequestedAt is the whole point of the grace period:
    // a Cancel pressed by mistake is undone by pressing Confirm, and
    // nothing was ever cancelled in Shopify.
    data: { codConfirmed: true, cancelRequestedAt: null },
  });

  await tagOrder(
    domain,
    order.shopifyId,
    by === "silence" ? [TAG_CONFIRMED, TAG_AUTO_CONFIRMED] : [TAG_CONFIRMED],
    [TAG_CANCEL_REQUESTED],
  );

  if (eventEnabled(shop, "cod_confirmed")) {
    const v = blankVars();
    v.name = order.customerName || "there";
    v.order = order.orderNumber;
    v.item = order.itemLine || "your order";
    v.eta = etaDate(order.createdAt ?? new Date(), 7);

    await queueMessage({ shopId: shop.id, orderId: order.id, event: "cod_confirmed", to: order.phone, vars: v });
  }
}

async function onConfirm(ctx: Ctx) {
  const { shop, order, domain } = ctx;

  if (!order.isCod || order.codConfirmed === true) {
    await reply(ctx, `Order ${order.orderNumber} is already confirmed - thank you. We will message you the moment it ships.`);
    return;
  }

  await confirmCod(shop, order, domain, "customer");

  // The confirmation has gone; now the offer, as its own plain-text
  // message. The customer wrote to us a moment ago, so the 24-hour
  // window is open and this needs no template - which is the point.
  // Put a saving inside cod_confirmed and Meta reclassifies the whole
  // template as marketing, where it is charged and can be held back by
  // per-user limits. An order confirmation must never be held back.
  if (!ctx.quiet) await offerPayNow({ shop, order, domain, to: ctx.to });
}

async function onCancel(ctx: Ctx) {
  const { shop, order, domain } = ctx;
  const n = order.orderNumber;

  // Already with the courier: the cancel button on an old message cannot
  // call a parcel back. Declining it at the door does the same job.
  if (order.shipments?.length) {
    await tagOrder(domain, order.shopifyId, [TAG_CANCEL_TOO_LATE], []);
    await reply(
      ctx,
      `Order ${n} has already been handed to the courier, so it cannot be cancelled now. ` +
        `If you no longer want it, please decline the parcel at the door and it will come back to us.`,
    );
    await tellOwner(ctx, "Wanted to cancel, but the order is already dispatched - told them to decline at the door");
    return;
  }

  await db.orderRecord.update({
    where: { id: order.id },
    data: { codConfirmed: false, cancelRequestedAt: new Date() },
  });
  await tagOrder(domain, order.shopifyId, [TAG_CANCEL_REQUESTED], [TAG_CONFIRMED]);
  console.log(`[inbound] ${n} cancellation requested - waiting out the grace period`);

  if (!order.isCod) {
    await reply(
      ctx,
      `We have noted your request to cancel order ${n}. As it was paid online, our team will ` +
        `confirm the cancellation and the refund with you shortly.`,
    );
    await tellOwner(ctx, "Asked to cancel a PREPAID order - needs your decision and a refund");
    return;
  }

  if (shop.autoCancel) {
    const min = Math.max(1, shop.cancelGraceMin);
    await reply(
      ctx,
      `We have noted your request to cancel order ${n}. It will be cancelled in about ${min} minutes. ` +
        `Changed your mind? Reply CONFIRM before then and we will keep it.`,
    );
  } else {
    await reply(ctx, `We have noted your request to cancel order ${n}. Our team will confirm it shortly.`);
  }
  await tellOwner(ctx, shop.autoCancel ? "Asked to cancel - it cancels itself after the grace period unless they confirm" : "Asked to cancel - auto-cancel is off, so it waits for you");
}

/** The question behind each of the three buttons. */
async function onAsk(ctx: Ctx, what: "address" | "phone" | "help") {
  const n = ctx.order.orderNumber;
  const ask = {
    address:
      `Sure. Please send the complete new address for order ${n} in one message - house or flat number, ` +
      `street or area, city and PIN code - and we will pass it to the courier.`,
    phone:
      `Sure. Please send the correct 10-digit mobile number for order ${n} and we will pass it to the courier.`,
    help:
      `We are here to help. Please tell us what went wrong with order ${n} and we will sort it out.`,
  }[what];
  await reply(ctx, ask);
}

/** "[image]", "[audio]" - a message we were sent but cannot read. */
const MEDIA = /^\[[a-z]+\]$/;

async function onAddress(ctx: Ctx) {
  const { order, domain, text } = ctx;

  if (MEDIA.test(text.trim())) {
    await reply(ctx, "We can only read a typed address here. Please type the full address in one message - house or flat number, street or area, city and PIN code.");
    await db.inboundMessage.update({ where: { id: ctx.row.id }, data: { intent: "address" } }).catch(() => {});
    return;
  }

  const note = `New address from the customer on WhatsApp: ${oneLine(text, 400)}`;

  await db.orderRecord.update({ where: { id: order.id }, data: { changeNote: note.slice(0, 900) } });
  await tagOrder(domain, order.shopifyId, [TAG_ADDRESS_CHANGE], []);
  await noteOrder(domain, order.shopifyId, note);

  await reply(
    ctx,
    `Thank you. We have noted the new address for order ${order.orderNumber} and will pass it to the courier. ` +
      `We will message you if anything else is needed.`,
  );
  await tellOwner(ctx, "Sent a NEW ADDRESS - update the courier / Shopify order");
}

async function onPhone(ctx: Ctx) {
  const { order, domain, text } = ctx;

  // Ten digits, with or without +91, spaces or dashes between them.
  const m = String(text).replace(/[\s-]/g, "").match(/(?:\+?91)?([6-9]\d{9})(?!\d)/);
  if (!m) {
    await reply(ctx, "That does not look like a 10-digit mobile number. Please send just the number, like 98765 43210.");
    // Keep the question open: the next message is still the answer.
    await db.inboundMessage.update({ where: { id: ctx.row.id }, data: { intent: "phone" } }).catch(() => {});
    return;
  }

  const num = m[1];
  const note = `New phone number from the customer on WhatsApp: ${num}`;
  await db.orderRecord.update({ where: { id: order.id }, data: { changeNote: note } });
  await tagOrder(domain, order.shopifyId, [TAG_PHONE_CHANGE], []);
  await noteOrder(domain, order.shopifyId, note);

  await reply(
    ctx,
    `Thank you. We have noted ${num.slice(0, 5)} ${num.slice(5)} for order ${order.orderNumber} and will pass it to the courier.`,
  );
  await tellOwner(ctx, `Sent a NEW PHONE NUMBER ${num} - update the courier / Shopify order`);
}

async function onHelp(ctx: Ctx) {
  const { order, domain, text } = ctx;
  await tagOrder(domain, order.shopifyId, [TAG_HELP], []);
  await reply(
    ctx,
    MEDIA.test(text.trim())
      ? `Thank you. We cannot open photos or files on this number, so please also describe the problem in a few words. Our team will get back to you on this number shortly.`
      : `Thank you for telling us. Our team will look into it and get back to you on this number shortly.`,
  );
  await tellOwner(ctx, "Needs HELP - please reply to the customer");
}

/** Where the parcel is, from our own copy of the courier's scans. */
async function onTrack(ctx: Ctx) {
  const { order, domain } = ctx;
  const n = order.orderNumber;
  const item = order.itemLine || "your order";
  const link = trackLink(domain, order);
  const s = order.shipments?.[0];

  let line: string;
  if (order.cancelledAt) {
    line = `Order ${n} was cancelled.`;
  } else if (!s) {
    line =
      order.isCod && order.codConfirmed === null && eventEnabled(ctx.shop, "cod_confirm")
        ? `Order ${n} (${item}) is waiting for your confirmation. Reply CONFIRM to keep it.`
        : `Order ${n} (${item}) is confirmed and being packed - expected delivery ${etaDate(order.createdAt ?? new Date(), 7)}. We will message you the moment it ships.`;
  } else {
    const where = s.lastEventLoc ? ` Last seen at ${s.lastEventLoc}.` : "";
    const eta = etaDate(s.createdAt ?? new Date(), 4);
    line = {
      delivered: `Order ${n} (${item}) was delivered${s.lastEventAt ? ` on ${stamp(s.lastEventAt)}` : ""}.`,
      out_for_delivery: `Order ${n} (${item}) is out for delivery today. Please keep your phone reachable.`,
      in_transit: `Order ${n} (${item}) is on its way, arriving by ${eta}.${where}`,
      exception: `Order ${n} (${item}) is held up with the courier - we are looking into it.${where}`,
      returned: `Order ${n} (${item}) is on its way back to us.`,
    }[String(s.status)] ?? `Order ${n} (${item}) has been handed to ${s.carrier || "the courier"}, arriving by ${eta}.`;
  }

  await reply(ctx, `${line}\n\nFollow it live here:\n${link}`);
}

/** Read nothing we act on: say so, and hand over the menu. */
async function onUnknown(ctx: Ctx) {
  await menu(ctx, "Sorry, we could not understand your message.");
  await tellOwner(ctx, "Could not understand it - sent an apology and the menu");
}

/* ------------------------------------------------------------------ */
/*  The merchant's own WhatsApp                                        */
/* ------------------------------------------------------------------ */

/** A template variable may not carry a line break, a tab, or a run of spaces. */
function oneLine(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t || "-";
}

/**
 * Forwards what the customer said, and what we did about it, to the
 * merchant's own number - as the owner_alert template, since the merchant
 * has not written to the business number and no free-form message can
 * reach them. When the template is missing or refused, the same words are
 * tried as plain text, which arrives if the merchant has messaged the
 * business number within the day.
 */
async function tellOwner(ctx: Ctx, action: string) {
  const { shop, order } = ctx;
  const to = String(shop.ownerPhone ?? "").replace(/\D/g, "");
  if (!shop.ownerAlerts || !to || !shop.waEnabled || !shop.waToken || !shop.waPhoneNumberId) return;
  // The merchant testing the bot from their own phone should not be told
  // about their own message.
  if (to === ctx.to) return;

  const params = [
    oneLine(order?.customerName || "Customer", 60),
    prettyPhone(ctx.to),
    order?.orderNumber || "-",
    oneLine(ctx.text, 300),
    oneLine(action, 200),
  ];

  let res = await sendTemplate({
    phoneNumberId: shop.waPhoneNumberId,
    token: shop.waToken,
    wabaId: shop.waWabaId,
    to,
    template: OWNER_TEMPLATE,
    params,
  });

  if (!res.ok) {
    console.log(`[inbound] owner_alert not sent (${res.error}) - trying plain text`);
    res = await sendText({
      phoneNumberId: shop.waPhoneNumberId,
      token: shop.waToken,
      to,
      body:
        `Customer message: ${params[0]} (${params[1]}), order ${params[2]}: "${params[3]}"\n` +
        `Bot replied: ${params[4]}`,
    });
  }

  await db.inboundMessage.update({ where: { id: ctx.row.id }, data: { forwarded: res.ok } }).catch(() => {});
  console.log(`[inbound] owner ${res.ok ? "told" : "NOT told: " + res.error}`);
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

      // The reason goes on first, so the orders/cancelled webhook that
      // follows knows this one deserves its cancellation message.
      await db.orderRecord.update({
        where: { id: order.id },
        data: { cancelReason: "customer" },
      });

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
