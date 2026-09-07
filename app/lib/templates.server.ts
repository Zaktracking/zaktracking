/**
 * Every event's template, along with its variables.
 *
 * Everything in one place: which template to call, what to fill into its
 * {{1}} {{2}}, and what goes into the button. If some text changes later,
 * only this file has to change.
 *
 * The order of params is the order the body is written in WhatsApp Manager.
 * One position out of place and the customer gets a garbled message.
 */

export type Vars = {
  name: string;      // Rahul
  order: string;     // Z1001
  item: string;      // Portable Blender + 1 more item
  amount: string;    // INR 899
  eta: string;       // 14 September
  courier: string;   // Delhivery
  tracking: string;  // 1234567890
  city: string;      // Patna
  address: string;   // Bettiah, Bihar 845438
  reason: string;    // your phone could not be reached
  attempts: string;  // three
  date: string;      // 27 August, 3:45 PM
  method: string;    // UPI
  code: string;      // WELCOME10
  handle: string;    // portable-blender
  cart: string;      // a7f3k9
};

type Def = {
  template: string;
  params: (v: Vars) => string[];
  /**
   * The values in the order the template had before September 2026, when
   * the customer's name was still its {{1}}. Kept until every template has
   * been re-approved without it; see altParams in whatsapp.server.ts.
   */
  old?: (v: Vars) => string[];
  /** the trailing part of the dynamic URL button */
  button?: (v: Vars) => string;
  marketing?: boolean;
};

export const EVENTS: Record<string, Def> = {
  order_created:    { template: "order_placed",      params: v => [v.name, v.order, v.item, v.amount, v.eta] },
  cod_confirm:      { template: "cod_confirm",       params: v => [v.name, v.order, v.item, v.amount] },
  cod_reminder:     { template: "cod_reminder",      params: v => [v.name, v.order, v.item, v.amount] },
  cod_confirmed:    { template: "cod_confirmed",     params: v => [v.order, v.item, v.eta],                        old: v => [v.name, v.order, v.item, v.eta] },
  order_paid:       { template: "payment_received",  params: v => [v.name, v.amount, v.order, v.item, v.eta] },

  shipped:          { template: "order_shipped",     params: v => [v.order, v.item, v.courier, v.tracking, v.eta], old: v => [v.name, v.order, v.item, v.courier, v.tracking, v.eta], button: v => v.tracking },
  in_transit:       { template: "order_in_transit",  params: v => [v.order, v.city, v.item, v.eta],               old: v => [v.name, v.order, v.city, v.item, v.eta],               button: v => v.tracking },
  out_for_delivery: { template: "out_for_delivery",  params: v => [v.order, v.item, v.address, v.amount],         old: v => [v.name, v.order, v.item, v.address, v.amount],         button: v => v.tracking },
  delivery_failed:  { template: "delivery_failed",   params: v => [v.order, v.item, v.reason],                    old: v => [v.name, v.order, v.item, cap(v.reason)] },
  rto_alert:        { template: "rto_alert",         params: v => [v.order, v.attempts, v.item],                  old: v => [v.name, v.order, v.attempts, v.item] },
  delivered:        { template: "order_delivered",   params: v => [v.order, v.item, v.date],                      old: v => [v.name, v.order, v.item, v.date] },

  cancelled:        { template: "order_cancelled",   params: v => [v.order, v.item, v.amount],                    old: v => [v.name, v.order, v.item, v.amount] },
  refunded:         { template: "refund_initiated",  params: v => [v.amount, v.order, v.item],                    old: v => [v.name, v.amount, v.order, v.item, v.method] },

  abandoned_1:      { template: "abandoned_cart_1",  params: v => [v.name, v.item, v.amount], button: v => v.cart, marketing: true },
  abandoned_2:      { template: "abandoned_cart_2",  params: v => [v.item, v.code],           old: v => [v.name, v.item, v.code], button: v => v.cart, marketing: true },
  review:           { template: "review_request",    params: v => [v.name, v.item],           button: v => v.handle, marketing: true },
  back_in_stock:    { template: "back_in_stock",     params: v => [v.name, v.item, v.amount], button: v => v.handle, marketing: true },
};

/** "nobody was available" -> "Nobody was available": the previous wording of
 *  delivery_failed prints the reason after "Reason:", where it starts a line. */
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Empty Vars, so that every field is present everywhere. */
export function blankVars(): Vars {
  return {
    name: "", order: "", item: "", amount: "", eta: "", courier: "",
    tracking: "", city: "", address: "", reason: "", attempts: "",
    date: "", method: "", code: "", handle: "", cart: "",
  };
}

/**
 * Lines that a Cash-on-Delivery app adds to the order but that the customer
 * never thinks of as a product. COD King writes a zero-priced "Partial
 * Payment" line, and some apps duplicate the real product at zero. Naming
 * those in a message reads like a mistake, so they are left out.
 */
const HELPER_LINE = /partial\s*payment|cod\s*(fee|charge|advance)|shipping\s*protection|insurance/i;

/**
 * The order's item names on a single line.
 *   one item       -> "Portable Blender"
 *   more than one  -> "Portable Blender + 2 more items"
 * Long names get truncated, otherwise they break badly on WhatsApp.
 */
export function itemLine(order: any): string {
  let li: any[] = order?.line_items ?? [];
  if (!li.length) return "your order";

  const real = li.filter((l: any) => {
    const title = String(l?.title ?? l?.name ?? "");
    if (HELPER_LINE.test(title)) return false;
    // A zero-priced line beside a paid one is the COD app's placeholder,
    // not a free gift the customer chose.
    const price = Number(l?.price ?? l?.original_price ?? 0);
    if (li.length > 1 && Number.isFinite(price) && price === 0) return false;
    return true;
  });

  if (real.length) li = real;

  let first = String(li[0].title ?? li[0].name ?? "your order").trim();
  if (first.length > 46) first = first.slice(0, 45).trimEnd() + "…";

  const rest = li.length - 1;
  if (rest <= 0) return first;
  return `${first} + ${rest} more item${rest > 1 ? "s" : ""}`;
}

/**
 * What the order is really worth.
 *
 * A partial-payment COD app can leave total_price at zero on the webhook
 * that creates the order - the money is recorded as still outstanding
 * instead. "Total: INR 0" in a message looks broken, so we take the first
 * figure that is actually a number greater than zero.
 */
export function orderTotal(order: any): string | null {
  const candidates = [
    order?.total_price,
    order?.current_total_price,
    order?.total_outstanding,
    order?.subtotal_price,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return String(c);
  }
  return candidates.find((c) => c != null && String(c).trim() !== "") ?? null;
}

/** What is still to be collected at the door, if anything. */
export function amountDue(order: any): string | null {
  const n = Number(order?.total_outstanding);
  if (Number.isFinite(n) && n > 0) return String(order.total_outstanding);
  return null;
}

/** "INR 899" - so it always looks the same in every message. */
export function money(amount?: string | null, currency?: string | null): string {
  const n = num(amount);
  if (n === null) return "";
  const cur = String(currency || "INR").toUpperCase();
  return cur === "INR" ? `\u20b9${n}` : `${cur} ${n}`;
}

/**
 * The same amount, but for a WhatsApp template variable - no currency at
 * all, just "1,794".
 *
 * Every template already has its own rupee sign typed in front of the
 * variable, where Meta can see it and approve it. Sending "INR 1,794" into
 * that slot printed "\u20b9INR 1,794" on the customer's phone.
 */
export function amountVar(amount?: string | null, _currency?: string | null): string {
  return num(amount) ?? "";
}

/**
 * 1794 -> "1,794" and 1794.2 -> "1,794.20". Paise are kept when there are
 * any, because this is the figure a courier collects at the door and it
 * has to match the order to the last coin.
 */
function num(amount?: string | null): string | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: n % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/**
 * A moment in time as the clock in India shows it. The server runs on UTC,
 * so 8 PM in Bihar is a different calendar day there - the customer must
 * read the day and hour they live in.
 */
function ist(d: Date) {
  const p: Record<string, string> = {};
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  for (const x of parts) p[x.type] = x.value;
  return {
    y: Number(p.year), m: Number(p.month), d: Number(p.day),
    h: Number(p.hour), min: p.minute, ap: String(p.dayPeriod ?? "").toUpperCase(),
  };
}

/**
 * The delivery date - one day, like "14 September".
 *
 * Seven working days after the order is placed, four after it is handed to
 * the courier. Sundays do not count, because couriers skip them too. It is
 * a single date rather than a range: a customer plans around "by the
 * 14th", nobody plans around "between the 10th and the 14th".
 */
export function etaDate(from = new Date(), workingDays = 7): string {
  const t = ist(from);
  const out = new Date(Date.UTC(t.y, t.m - 1, t.d, 12));
  let left = workingDays;
  while (left > 0) {
    out.setUTCDate(out.getUTCDate() + 1);
    if (out.getUTCDay() !== 0) left--;
  }
  return `${out.getUTCDate()} ${M[out.getUTCMonth()]}`;
}

/** "27 August, 3:45 PM" - for the delivered message, in India's clock. */
export function stamp(d = new Date()): string {
  const t = ist(d);
  return `${t.d} ${M[t.m - 1]}, ${t.h}:${t.min} ${t.ap}`;
}

/** A short one-line shipping address - "Bettiah, Bihar 845438". */
export function shortAddress(order: any): string {
  const a = order?.shipping_address ?? order?.billing_address ?? {};
  return [a.city, a.province, a.zip].filter(Boolean).join(", ") || "your address";
}

/** A human-readable line for display on the admin page. */
export function preview(event: string, v: Vars): string {
  const def = EVENTS[event];
  if (!def) return "";
  return `${def.template}(${def.params(v).filter(Boolean).join(", ")})`;
}
