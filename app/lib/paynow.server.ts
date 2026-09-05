/**
 * "Pay online now and save" - what turns a Cash on Delivery order into a
 * paid one.
 *
 * It goes as plain text, not a template, in the seconds after the customer
 * replies CONFIRM. They have just written to us, so the 24-hour service
 * window is open and Meta allows any message inside it. That matters more
 * than it sounds: a saving inside a template gets the template reclassified
 * as marketing, and marketing templates are both charged and subject to
 * per-user limits that can stop an order confirmation reaching someone.
 * A confirmation must never be the message that gets dropped.
 *
 * The link is short on purpose - /apps/track/pay/<id> rather than a cart
 * permalink two hundred characters long, which reads like spam and is what
 * people refuse to tap. That route builds the real cart link when tapped:
 * same items, the pay-online code, and one attribute naming the COD order
 * it replaces. When the new order is paid, orders/paid reads the attribute
 * and cancels the COD twin, so nothing is ever packed twice.
 */

import { unauthenticated } from "../shopify.server";
import db from "../db.server";
import { sendCta, sendText } from "./whatsapp.server";
import { money } from "./templates.server";

/** The cart attribute that ties a new prepaid order to its COD original. */
export const PAY_ATTR = "Pay now for order";

/** What the buy form falls back to, kept the same on purpose. */
const DEFAULT_OFF = "35";

/** The order's lines as Shopify's permalink wants them: variant:quantity. */
async function lines(domain: string, shopifyOrderId: string) {
  const { admin } = await unauthenticated.admin(domain);
  const res = await admin.graphql(
    `#graphql
     query zakPayLines($id: ID!) {
       order(id: $id) {
         lineItems(first: 50) { nodes { quantity variant { id } } }
       }
     }`,
    { variables: { id: `gid://shopify/Order/${shopifyOrderId}` } },
  );
  const json: any = await res.json();
  const nodes = json?.data?.order?.lineItems?.nodes ?? [];

  const parts: string[] = [];
  let count = 0;
  for (const n of nodes) {
    const id = String(n?.variant?.id ?? "").split("/").pop();
    const qty = Number(n?.quantity) || 0;
    if (!id || qty < 1) continue;
    parts.push(`${id}:${qty}`);
    count += qty;
  }
  return { permalink: parts.join(","), count };
}

/**
 * Offers the saving once, right after a COD order is confirmed.
 *
 * Everything here is best effort: a shop with no code set, an order whose
 * lines cannot be read, a message that will not send - each simply means
 * no offer, never a broken confirmation.
 */
export async function offerPayNow(opts: {
  shop: any;
  order: any;
  domain: string;
  to: string;
}) {
  const { shop, order, domain, to } = opts;
  try {
    if (!shop?.waEnabled || !shop.waToken || !shop.waPhoneNumberId) return;

    const per = Number(shop.prepaidOff ?? DEFAULT_OFF) || Number(DEFAULT_OFF);
    if (!String(shop.prepaidCode || "").trim()) return;

    const due = Number(order.outstanding ?? order.totalPrice);
    if (!Number.isFinite(due) || due <= 0) return;

    const { count } = await lines(domain, order.shopifyId);
    if (!count) return;

    const off = per * count;
    // A saving that swallows the whole order is a mistake, not an offer.
    if (off >= due) return;

    const url = `https://${domain}/apps/track/pay/${order.id}`;
    // It lands right under the confirmation, so it does not repeat it -
    // it carries on from it. The two figures are bold because they are the
    // only two the eye needs; bolding more would mean bolding nothing.
    const save = money(String(off), order.currency);
    const pay = money(String(due - off), order.currency);
    const body =
      `One more thing - pay online now and save *${save}*.\n` +
      `*${pay}* instead of ${money(String(due), order.currency)} at the door. ` +
      `UPI, card or net banking.\n\n` +
      `Or ignore this and pay cash on delivery as usual - order ${order.orderNumber} ` +
      `is confirmed either way.`;

    // Meta caps a button label at 20 characters. "Pay ₹1,759 online" fits
    // and says what tapping costs; anything longer falls back to the plain
    // words rather than being cut off mid-figure.
    const withAmount = `Pay ${pay} online`;
    const label = withAmount.length <= 20 ? withAmount : "Pay online now";

    // MessageLog's unique([orderId, event, channel]) is the lock: a second
    // CONFIRM on the same order cannot send this twice.
    let row;
    try {
      row = await db.messageLog.create({
        data: {
          shopId: shop.id,
          orderId: order.id,
          channel: "whatsapp",
          event: "pay_now",
          to,
          body,
          status: "queued",
        },
      });
    } catch {
      console.log(`[pay-now] ${order.orderNumber} was offered already`);
      return;
    }

    // The button first. If Meta refuses it for any reason the same words go
    // as plain text with the link written out - an offer that arrives
    // plainly beats one that does not arrive.
    let res = await sendCta({
      phoneNumberId: shop.waPhoneNumberId,
      token: shop.waToken,
      to,
      body,
      label,
      url,
    });
    if (!res.ok) {
      console.log(`[pay-now] button refused (${res.error}) - sending the link instead`);
      res = await sendText({
        phoneNumberId: shop.waPhoneNumberId,
        token: shop.waToken,
        to,
        body: `${body}\n\n${url}`,
      });
    }

    await db.messageLog.update({
      where: { id: row.id },
      data: res.ok
        ? { status: "sent", providerId: res.id, sentAt: new Date(), error: null }
        : { status: res.permanent ? "failed" : "queued", error: res.error },
    });

    console.log(
      `[pay-now] ${order.orderNumber} ${res.ok ? "offered" : "not sent: " + res.error}`,
    );
  } catch (e: any) {
    console.log(`[pay-now] ${opts.order?.orderNumber}: ${e?.message ?? e}`);
  }
}

/**
 * The real cart link the short link redirects to. Empty when there is
 * nothing to offer - no code set, or no readable lines.
 */
export async function payUrl(opts: {
  shop: any;
  order: any;
  domain: string;
}): Promise<string> {
  const code = String(opts.shop?.prepaidCode || "").trim();
  if (!code) return "";

  const { permalink } = await lines(opts.domain, opts.order.shopifyId);
  if (!permalink) return "";

  return (
    `https://${opts.domain}/cart/${permalink}` +
    `?discount=${encodeURIComponent(code)}` +
    `&attributes[${encodeURIComponent(PAY_ATTR)}]=${encodeURIComponent(opts.order.orderNumber)}`
  );
}

/** The COD order a freshly paid one was meant to replace, if any. */
export function replacedOrderNumber(order: any): string {
  const list = order?.note_attributes ?? [];
  for (const a of list) {
    if (String(a?.name ?? "") === PAY_ATTR) return String(a?.value ?? "").trim();
  }
  return "";
}
