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
  eta: string;       // 3-7 September
  courier: string;   // Delhivery
  tracking: string;  // 1234567890
  city: string;      // Patna
  address: string;   // Bettiah, Bihar 845438
  reason: string;    // Customer not reachable
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
  /** the trailing part of the dynamic URL button */
  button?: (v: Vars) => string;
  marketing?: boolean;
};

export const EVENTS: Record<string, Def> = {
  order_created:    { template: "order_placed",      params: v => [v.name, v.order, v.item, v.amount, v.eta] },
  cod_confirm:      { template: "cod_confirm",       params: v => [v.name, v.order, v.item, v.amount] },
  cod_reminder:     { template: "cod_reminder",      params: v => [v.name, v.order, v.item, v.amount] },
  cod_confirmed:    { template: "cod_confirmed",     params: v => [v.name, v.order, v.item, v.eta] },
  order_paid:       { template: "payment_received",  params: v => [v.name, v.amount, v.order, v.item, v.eta] },

  shipped:          { template: "order_shipped",     params: v => [v.name, v.order, v.item, v.courier, v.tracking, v.eta], button: v => v.tracking },
  in_transit:       { template: "order_in_transit",  params: v => [v.name, v.order, v.city, v.item, v.eta],               button: v => v.tracking },
  out_for_delivery: { template: "out_for_delivery",  params: v => [v.name, v.order, v.item, v.address, v.amount],         button: v => v.tracking },
  delivery_failed:  { template: "delivery_failed",   params: v => [v.name, v.order, v.item, v.reason] },
  rto_alert:        { template: "rto_alert",         params: v => [v.name, v.order, v.attempts, v.item] },
  delivered:        { template: "order_delivered",   params: v => [v.name, v.order, v.item, v.date] },

  cancelled:        { template: "order_cancelled",   params: v => [v.name, v.order, v.item, v.amount] },
  refunded:         { template: "refund_initiated",  params: v => [v.name, v.amount, v.order, v.item, v.method] },

  abandoned_1:      { template: "abandoned_cart_1",  params: v => [v.name, v.item, v.amount], button: v => v.cart, marketing: true },
  abandoned_2:      { template: "abandoned_cart_2",  params: v => [v.name, v.item, v.code],   button: v => v.cart, marketing: true },
  review:           { template: "review_request",    params: v => [v.name, v.item],           button: v => v.handle, marketing: true },
  back_in_stock:    { template: "back_in_stock",     params: v => [v.name, v.item, v.amount], button: v => v.handle, marketing: true },
};

/** Empty Vars, so that every field is present everywhere. */
export function blankVars(): Vars {
  return {
    name: "", order: "", item: "", amount: "", eta: "", courier: "",
    tracking: "", city: "", address: "", reason: "", attempts: "",
    date: "", method: "", code: "", handle: "", cart: "",
  };
}

/**
 * The order's item names on a single line.
 *   one item       -> "Portable Blender"
 *   more than one  -> "Portable Blender + 2 more items"
 * Long names get truncated, otherwise they break badly on WhatsApp.
 */
export function itemLine(order: any): string {
  const li: any[] = order?.line_items ?? [];
  if (!li.length) return "your order";

  let first = String(li[0].title ?? li[0].name ?? "your order").trim();
  if (first.length > 46) first = first.slice(0, 45).trimEnd() + "…";

  const rest = li.length - 1;
  if (rest <= 0) return first;
  return `${first} + ${rest} more item${rest > 1 ? "s" : ""}`;
}

/** "INR 899" - so it always looks the same in every message. */
export function money(amount?: string | null, currency?: string | null): string {
  if (!amount) return "";
  const n = Number(amount);
  const clean = Number.isFinite(n) ? n.toLocaleString("en-IN") : amount;
  return `${currency || "INR"} ${clean}`;
}

/**
 * The delivery estimate - something like "3-7 September".
 *
 * This is an estimate, not a promise. Per the shipping policy it is 2 to 6
 * working days after dispatch. We skip Sundays, because couriers skip them too.
 */
export function etaRange(from = new Date(), minDays = 2, maxDays = 6): string {
  const add = (d: Date, work: number) => {
    const out = new Date(d);
    let left = work;
    while (left > 0) {
      out.setDate(out.getDate() + 1);
      if (out.getDay() !== 0) left--;   // Sundays do not count
    }
    return out;
  };
  const a = add(from, minDays);
  const b = add(from, maxDays);
  const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  if (a.getMonth() === b.getMonth()) return `${a.getDate()}-${b.getDate()} ${M[a.getMonth()]}`;
  return `${a.getDate()} ${M[a.getMonth()]} - ${b.getDate()} ${M[b.getMonth()]}`;
}

/** "27 August, 3:45 PM" - for the delivered message. */
export function stamp(d = new Date()): string {
  const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${M[d.getMonth()]}, ${h}:${m} ${ap}`;
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
