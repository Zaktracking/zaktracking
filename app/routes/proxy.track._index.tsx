import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy, esc, liquid } from "../lib/proxy.server";
import { STATUS_LABEL } from "../lib/track.server";

/**
 * The actual tracking page - zakdor.com/apps/track
 *
 * This is a resource route (no default export), so the Response that
 * leaves here goes straight to the browser. Serving it with Content-Type
 * application/liquid makes Shopify place it between the theme header and
 * footer - the page looks like the rest of the store on its own.
 *
 * It opens in two ways:
 *   /apps/track?n=<tracking number>   - from the WhatsApp button
 *   /apps/track?order=Z1005&pin=8695  - customer types it in
 *
 * The order number alone is not enough. Guessing Z1006 after Z1005 is far
 * too easy, and that would expose someone else's address. So we also ask
 * for the last 4 digits of the phone number, or the email.
 */

const STEPS = ["Confirmed", "Shipped", "In transit", "Out for delivery", "Delivered"];

const STEP_OF: Record<string, number> = {
  pending: 1,
  info_received: 1,
  in_transit: 2,
  out_for_delivery: 3,
  delivered: 4,
  exception: 2,
  returned: 2,
};

function fmt(d: any): string {
  if (!d) return "";
  const x = new Date(d);
  if (isNaN(x.getTime())) return "";
  return x.toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

const CSS = `
<style>
.zt-wrap
{max-width:780px;margin:0 auto;padding:38px 18px 70px;font-family:inherit;color:#16181d}
.zt-h1
{font-size:30px;line-height:1.15;font-weight:700;margin:0 0 8px;letter-spacing:-.02em}
.zt-sub
{color:#65686f;font-size:15px;margin:0 0 26px}
.zt-card
{border:1px solid #e6e7ea;border-radius:16px;padding:22px;background:#fff;margin-bottom:18px}
.zt-form
{display:flex;gap:10px;flex-wrap:wrap}
.zt-form .zt-f
{flex:1 1 190px}
.zt-lab
{display:block;font-size:12px;font-weight:600;color:#65686f;margin-bottom:6px;letter-spacing:.02em;text-transform:uppercase}
.zt-in
{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #d3d5da;border-radius:10px;font-size:15px;background:#fff;color:#16181d}
.zt-in:focus
{outline:none;border-color:#16181d;box-shadow:0 0 0 3px rgba(22,24,29,.08)}
.zt-btn
{background:#16181d;color:#fff;border:0;border-radius:10px;padding:13px 26px;font-size:15px;font-weight:600;cursor:pointer;align-self:flex-end}
.zt-btn:hover
{background:#33363d}
.zt-hero
{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-bottom:22px}
.zt-status
{font-size:24px;font-weight:700;margin:2px 0 4px;letter-spacing:-.01em}
.zt-when
{color:#65686f;font-size:14px;margin:0}
.zt-ord
{text-align:right}
.zt-ord b
{display:block;font-size:16px}
.zt-ord span
{color:#65686f;font-size:13px}
.zt-bar
{display:flex;margin:26px 0 10px}
.zt-step
{flex:1;text-align:center;position:relative}
.zt-dot
{width:15px;height:15px;border-radius:50%;background:#dfe1e5;margin:0 auto 9px;position:relative;z-index:2}
.zt-step.on .zt-dot
{background:#16181d}
.zt-step.now .zt-dot
{background:#16181d;box-shadow:0 0 0 5px rgba(22,24,29,.12)}
.zt-step:before
{content:"";position:absolute;top:7px;left:0;width:50%;height:2px;background:#dfe1e5;z-index:1}
.zt-step:after
{content:"";position:absolute;top:7px;right:0;width:50%;height:2px;background:#dfe1e5;z-index:1}
.zt-step:first-child:before,.zt-step:last-child:after
{display:none}
.zt-step.on:before,.zt-step.on:after
{background:#16181d}
.zt-step.now:after
{background:#dfe1e5}
.zt-slab
{font-size:11px;color:#8a8d94;font-weight:600;letter-spacing:.02em}
.zt-step.on .zt-slab
{color:#16181d}
.zt-note
{border-radius:12px;padding:14px 16px;font-size:14px;margin:18px 0 0;line-height:1.5}
.zt-warn
{background:#fff6e6;border-left:3px solid #b98900}
.zt-bad
{background:#fdeeec;border-left:3px solid #c4262e}
.zt-good
{background:#eaf7ef;border-left:3px solid #0f7a3d}
.zt-meta
{display:flex;gap:26px;flex-wrap:wrap;margin-top:22px;padding-top:18px;border-top:1px solid #eeeff1}
.zt-meta div p
{margin:0}
.zt-meta .k
{font-size:11px;color:#8a8d94;text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin-bottom:3px}
.zt-meta .v
{font-size:15px;font-weight:600}
.zt-hist
{list-style:none;margin:6px 0 0;padding:0}
.zt-hist li
{display:flex;gap:14px;padding:13px 0;border-bottom:1px solid #f2f3f5}
.zt-hist li:last-child
{border-bottom:0}
.zt-hist .t
{flex:0 0 118px;font-size:12px;color:#8a8d94;padding-top:2px}
.zt-hist .d
{font-size:14px}
.zt-hist .l
{font-size:12px;color:#8a8d94;margin-top:2px}
.zt-help
{text-align:center;color:#65686f;font-size:14px;margin-top:26px}
.zt-help a
{color:#16181d;font-weight:600}
@media (max-width:600px)
{
.zt-h1{font-size:24px}
.zt-ord{text-align:left}
.zt-btn{width:100%}
.zt-slab{font-size:10px}
.zt-hist .t{flex:0 0 92px}
}
</style>
`;

function shell(inner: string) {
  return `${CSS}<div class="zt-wrap">${inner}</div>`;
}

function form(order = "", pin = "", err = "") {
  return `
  <h1 class="zt-h1">Track your order</h1>
  <p class="zt-sub">Enter your order number and the last 4 digits of your phone number.</p>
  ${err ? `<div class="zt-note zt-bad">${esc(err)}</div>` : ""}
  <div class="zt-card">
    <form method="get" action="/apps/track" class="zt-form">
      <div class="zt-f">
        <label class="zt-lab" for="zt-o">Order number</label>
        <input class="zt-in" id="zt-o" name="order" value="${esc(order)}" placeholder="Z1005" required>
      </div>
      <div class="zt-f">
        <label class="zt-lab" for="zt-p">Phone - last 4 digits</label>
        <input class="zt-in" id="zt-p" name="pin" value="${esc(pin)}" placeholder="8695" inputmode="numeric" maxlength="4" required>
      </div>
      <button class="zt-btn" type="submit">Track</button>
    </form>
  </div>
  <p class="zt-help">Your order number is in your confirmation message. If something is not right, <a href="/pages/contact">tell us</a>.</p>`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // The signature is checked right here. If it is wrong, this throws a
  // 401 by itself and nothing below ever runs.
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  if (!domain) return liquid(shell(form("", "", "Something went wrong. Please open the page again.")));

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) return liquid(shell(form()));

  const num = (url.searchParams.get("n") ?? "").trim();
  const orderQ = (url.searchParams.get("order") ?? "").trim();
  const pin = (url.searchParams.get("pin") ?? "").trim();

  if (!num && !orderQ) return liquid(shell(form()));

  /* ---------------- look it up ---------------- */
  let rec: any = null;

  if (num) {
    const sh = await db.shipment.findFirst({
      where: { trackingNo: num, order: { shopId: shop.id } },
      orderBy: { createdAt: "desc" },
      include: { order: { include: { shipments: { orderBy: { createdAt: "desc" } } } } },
    });
    rec = sh?.order ?? null;
  } else {
    // Z1005, z1005, #1005, 1005 - all of these should work.
    const bare = orderQ.replace(/^[#Zz]+/, "");
    const cands = await db.orderRecord.findMany({
      where: {
        shopId: shop.id,
        OR: [
          { orderNumber: orderQ },
          { orderNumber: orderQ.toUpperCase() },
          { orderNumber: `Z${bare}` },
          { orderNumber: `#${bare}` },
          { orderNumber: bare },
        ],
      },
      include: { shipments: { orderBy: { createdAt: "desc" } } },
      take: 5,
    });

    // A second proof. Without it, anyone could type Z1006 after Z1005
    // and see someone else's address.
    const four = pin.replace(/\D/g, "").slice(-4);
    rec = cands.find((c) => {
      const ph = (c.phone ?? "").replace(/\D/g, "");
      return four.length === 4 && ph.endsWith(four);
    }) ?? null;

    if (!rec && cands.length > 0) {
      return liquid(shell(form(orderQ, pin, "Those last 4 digits do not match the phone number on this order.")));
    }
  }

  if (!rec) {
    return liquid(
      shell(form(orderQ, pin, "Nothing matched that order number. Please check and try again.")),
    );
  }

  /* ---------------- show it ---------------- */
  const ship = (rec.shipments ?? [])[0] ?? null;
  const st = ship?.status ?? "pending";
  const step = STEP_OF[st] ?? 0;
  const label = ship ? STATUS_LABEL[st] ?? "In progress" : "Order confirmed";

  const bar = STEPS.map((s, i) => {
    const cls = i < step ? "zt-step on" : i === step ? "zt-step on now" : "zt-step";
    return `<div class="${cls}"><div class="zt-dot"></div><div class="zt-slab">${esc(s)}</div></div>`;
  }).join("");

  let note = "";
  if (st === "delivered") {
    note = `<div class="zt-note zt-good">This order has been delivered. If it has not reached you, tell us right away and we will look into it.</div>`;
  } else if (st === "exception") {
    note = `<div class="zt-note zt-warn">The courier could not complete the delivery. They will try again. If the address or number needs to change, tell us now.</div>`;
  } else if (st === "returned") {
    note = `<div class="zt-note zt-bad">The parcel is on its way back to us. We can send it out again if you want - just message us.</div>`;
  } else if (st === "out_for_delivery") {
    note = `<div class="zt-note zt-good">It should reach you today. ${rec.isCod ? "Keep the cash ready." : "Payment is done, nothing to pay on delivery."}</div>`;
  }

  let scans: any[] = [];
  try {
    scans = ship?.scans ? JSON.parse(ship.scans) : [];
  } catch {
    scans = [];
  }

  const hist = scans.length
    ? `<div class="zt-card">
        <p class="zt-lab" style="margin-bottom:2px">Journey</p>
        <ul class="zt-hist">${scans
          .map(
            (e: any) => `<li>
              <div class="t">${esc(fmt(e.time))}</div>
              <div><div class="d">${esc(e.desc || "Update")}</div>${
                e.location ? `<div class="l">${esc(e.location)}</div>` : ""
              }</div>
            </li>`,
          )
          .join("")}</ul>
      </div>`
    : "";

  const meta = [
    ship?.carrier ? { k: "Courier", v: ship.carrier } : null,
    ship?.trackingNo ? { k: "Tracking number", v: ship.trackingNo } : null,
    rec.isCod ? { k: "Payment", v: `Cash on delivery` } : { k: "Payment", v: "Paid online" },
    rec.city ? { k: "Delivering to", v: rec.city } : null,
  ]
    .filter(Boolean)
    .map((m: any) => `<div><p class="k">${esc(m.k)}</p><p class="v">${esc(m.v)}</p></div>`)
    .join("");

  const body = `
  <h1 class="zt-h1">Your order</h1>
  <p class="zt-sub">This shows what the courier has scanned so far.</p>

  <div class="zt-card">
    <div class="zt-hero">
      <div>
        <p class="zt-lab" style="margin-bottom:2px">Status</p>
        <p class="zt-status">${esc(label)}</p>
        <p class="zt-when">${
          ship?.lastEventAt
            ? esc(`${ship.lastEventDesc || "Updated"} · ${fmt(ship.lastEventAt)}`)
            : "We are getting your parcel ready"
        }</p>
      </div>
      <div class="zt-ord">
        <b>${esc(rec.orderNumber)}</b>
        <span>${esc(rec.itemLine || "")}</span>
      </div>
    </div>

    <div class="zt-bar">${bar}</div>
    ${note}
    ${meta ? `<div class="zt-meta">${meta}</div>` : ""}
  </div>

  ${hist}

  <p class="zt-help">Something not right? <a href="/pages/contact">Tell us</a> - we will speak to the courier ourselves.</p>
  <p class="zt-help" style="margin-top:10px"><a href="/apps/track">Track another order</a></p>`;

  return liquid(shell(body));
};
