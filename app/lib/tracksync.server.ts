import db from "../db.server";
import { normalize, failReason, inWords, type Norm } from "./track.server";
import { queueMessage, eventEnabled } from "./notify.server";
import { blankVars, amountVar, stamp, etaDate } from "./templates.server";

/**
 * What to do when a courier scan arrives.
 *
 * This is the only place in the whole app where the "out for delivery",
 * "delivered", "delivery failed" and "RTO" messages are built. These four
 * never come from Shopify.
 *
 * Two layers keep a message from going out twice:
 *   1. If the status is the same as before we do nothing at all.
 *   2. If the same event still arrives twice, MessageLog's
 *      unique([orderId, event, channel]) stops it.
 */

/** which status sends which message */
const EVENT_FOR: Record<string, string> = {
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  exception: "delivery_failed",
  returned: "rto_alert",
};

/** once it lands here nothing further happens - polling stops */
export const FINAL = new Set(["delivered", "returned"]);

export async function applyToShipment(shipmentId: string, node: any) {
  const n = normalize(node);

  const sh = await db.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: { include: { shop: true } } },
  });
  if (!sh) return { changed: false, reason: "shipment not found" };

  const before = sh.status;
  const rec = sh.order;
  const shop = rec.shop;

  await db.shipment.update({
    where: { id: sh.id },
    data: {
      status: n.status,
      lastEventAt: n.time ?? sh.lastEventAt ?? new Date(),
      lastEventDesc: n.desc || sh.lastEventDesc,
      lastEventLoc: n.location || sh.lastEventLoc,
      subStatus: n.sub || null,
      carrier: n.carrierName || sh.carrier,
      carrierCode: n.carrierCode ?? sh.carrierCode,
      scans: n.events.length ? JSON.stringify(n.events) : sh.scans,
    },
  });

  // The status is exactly what it was - no question of a message.
  if (n.status === before) return { changed: false, status: n.status };

  const event = EVENT_FOR[n.status];
  if (!event) return { changed: true, status: n.status };
  if (!eventEnabled(shop, event)) return { changed: true, status: n.status, skipped: "turned off" };

  const v = blankVars();
  v.name = rec.customerName || "there";
  v.order = rec.orderNumber;
  v.item = rec.itemLine || "your order";
  // On a partial-payment COD order the balance is what the delivery agent
  // collects, not the order total. Asking for the total would be asking for
  // money the customer has already paid once.
  v.amount = amountVar(rec.outstanding ?? rec.totalPrice, rec.currency);
  v.courier = n.carrierName || sh.carrier || "our courier partner";
  v.tracking = sh.trackingNo || "";
  v.city = n.location || rec.city || "your city";
  v.address = rec.address || n.location || "your address";
  // "arriving by 12 September": four working days from the hand-over,
  // the same date the shipped message promised.
  v.eta = etaDate(sh.createdAt ?? new Date(), 4);
  v.date = stamp(n.time ?? new Date());
  v.reason = failReason(n.sub, n.desc);
  v.attempts = inWords(Math.max(n.attempts, 1));

  // Only ask for cash when there is cash to ask for.
  //
  // out_for_delivery already reads "Amount due: ₹{{5}}", rupee sign and
  // all, so what goes in is a bare number - the balance, not the total, on
  // an order that was part-paid. An order with nothing left to collect
  // reads "₹0.00 (Paid)", the way a settled bill does, so nobody is asked
  // to pay twice at the door.
  if (event === "out_for_delivery") {
    const due = Number(rec.outstanding ?? rec.totalPrice);
    v.amount = rec.isCod && Number.isFinite(due) && due > 0
      ? amountVar(String(due), rec.currency)
      : "0.00 (Paid)";
  }

  await queueMessage({
    shopId: shop.id,
    orderId: rec.id,
    event,
    to: rec.phone,
    vars: v,
  });

  console.log(`[track] ${rec.orderNumber} ${before} -> ${n.status} (${event} sent)`);
  return { changed: true, status: n.status, event };
}

/**
 * The push carries only the tracking number, not our shipment id (we do
 * send `tag`, but it does not come back on every courier). So looking it up
 * by number is the only dependable way.
 */
export async function applyByNumber(shopId: string, number: string, node: any) {
  if (!number) return { changed: false, reason: "number is empty" };

  const rows = await db.shipment.findMany({
    where: { trackingNo: number, order: { shopId } },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  if (rows.length === 0) return { changed: false, reason: `${number} is not one of ours` };

  const out = [];
  for (const r of rows) out.push(await applyToShipment(r.id, node));
  return out[0];
}

export type { Norm };
