/**
 * "Pay online now and save" - what turns a Cash on Delivery order into a
 * paid one.
 *
 * The offer rides inside the confirmation message itself. cod_confirmed
 * carries a Pay Now button, and that button points here. No second
 * message, no new template to get approved.
 *
 * A WhatsApp button can only vary the last part of its URL, and Meta will
 * not accept %, # or $ in that part - so the button carries the order's
 * own id, and proxy.track.pay turns it into the real cart link when it is
 * tapped. The link is an ordinary Shopify cart permalink holding the same
 * items, the pay-online code, and one attribute naming the COD order it
 * replaces. When that new order is paid, orders/paid reads the attribute
 * and cancels the COD twin, so nothing is ever packed twice.
 */

import { unauthenticated } from "../shopify.server";
import { amountVar } from "./templates.server";

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
 * What goes into the confirmation's {{5}}, where the template already
 * reads "...and save ₹{{5}}".
 *
 * A bare number, always - "40" - because the rupee sign is typed into the
 * template in front of it, the same as every other amount we send. And
 * always something: WhatsApp refuses a template whose variable is blank,
 * and a confirmation that fails to send is far worse than a saving that
 * is understated.
 *
 * So every way of not knowing falls back to a smaller number rather than
 * to words. If the order's lines cannot be read, one item's worth is
 * offered - never more than the customer will actually get.
 */
export async function savingLine(opts: {
  shop: any;
  order: any;
  domain: string;
}): Promise<string> {
  // The same figure the buy form offers, so the two never disagree.
  const per = Number(opts.shop?.prepaidOff ?? DEFAULT_OFF) || Number(DEFAULT_OFF);
  const one = amountVar(String(per));

  try {
    const { count } = await lines(opts.domain, opts.order.shopifyId);
    if (!count) return one;

    const off = per * count;
    const due = Number(opts.order.outstanding ?? opts.order.totalPrice);
    // A saving that swallows the whole order is a mistake, not an offer.
    if (Number.isFinite(due) && due > 0 && off >= due) return one;

    return amountVar(String(off));
  } catch {
    return one;
  }
}

/**
 * The real cart link behind the button. Empty when there is nothing to
 * offer - the shop has set no code, or the order has no readable lines.
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
