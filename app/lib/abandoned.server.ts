import db from "../db.server";
import { queueMessage, eventEnabled } from "./notify.server";
import { blankVars, money, amountVar } from "./templates.server";

/**
 * Abandoned cart.
 *
 * checkouts/update fires ten or fifteen times for a single shopper, so the
 * webhook sends nothing - it only moves the row along. The message goes out
 * from here, by the clock.
 *
 *   first reminder  - after 1 hour
 *   second reminder - after 24 hours, with a discount code
 *
 * As soon as the order arrives convertedAt is filled in and both stop.
 * Sending "your cart is waiting" to someone who just bought is the worst.
 */

const HOUR = 60 * 60 * 1000;

export async function sweepAbandoned() {
  const now = Date.now();
  const shops = await db.shop.findMany({ where: { onAbandoned: true } });
  let sent1 = 0, sent2 = 0, skipped = 0;

  for (const shop of shops) {
    if (!eventEnabled(shop, "abandoned_1")) continue;

    /* ---- first reminder: 1 hour ---- */
    const first = await db.abandonedCart.findMany({
      where: {
        shopId: shop.id,
        convertedAt: null,
        reminder1At: null,
        phone: { not: null },
        lastSeenAt: { lte: new Date(now - 1 * HOUR) },
      },
      take: 50,
    });

    for (const c of first) {
      const v = blankVars();
      v.name = c.name || "there";
      // Rows saved before the name was stored still fall back to a count.
      v.item = c.itemLine || (c.itemCount > 1 ? `${c.itemCount} items` : "your item");
      v.amount = amountVar(c.total, c.currency);
      v.cart = c.token;

      await queueMessage({
        shopId: shop.id,
        orderId: null,
        event: "abandoned_1",
        to: c.phone,
        vars: v,
      });
      await db.abandonedCart.update({
        where: { id: c.id },
        data: { reminder1At: new Date() },
      });
      sent1++;
    }

    /* ---- second reminder: 24 hours, with a code ---- */
    const code = (shop as any).abandonCode?.trim();

    const second = await db.abandonedCart.findMany({
      where: {
        shopId: shop.id,
        convertedAt: null,
        reminder1At: { not: null },
        reminder2At: null,
        phone: { not: null },
        lastSeenAt: { lte: new Date(now - 24 * HOUR) },
      },
      take: 50,
    });

    for (const c of second) {
      // We cannot invent a code ourselves. If the merchant has not given
      // one we skip the second reminder - better than sending a fake code.
      if (!code) {
        skipped++;
        continue;
      }
      const v = blankVars();
      v.name = c.name || "there";
      // Rows saved before the name was stored still fall back to a count.
      v.item = c.itemLine || (c.itemCount > 1 ? `${c.itemCount} items` : "your item");
      v.amount = amountVar(c.total, c.currency);
      v.code = code;
      v.cart = c.token;

      await queueMessage({
        shopId: shop.id,
        orderId: null,
        event: "abandoned_2",
        to: c.phone,
        vars: v,
      });
      await db.abandonedCart.update({
        where: { id: c.id },
        data: { reminder2At: new Date() },
      });
      sent2++;
    }
  }

  if (skipped) {
    console.log(
      `[abandoned] second reminder held back for ${skipped} carts - no discount code filled in on the admin page`,
    );
  }
  return { sent1, sent2, skipped };
}

/**
 * The order has arrived - stop chasing that cart.
 *
 * A Shopify order payload carries two tokens: cart_token and
 * checkout_token. Which one the checkouts webhook sends keeps changing with
 * the version - so we try both.
 */
export async function markConverted(shopId: string, tokens: (string | null | undefined)[]) {
  const list = tokens.filter(Boolean).map(String);
  if (list.length === 0) return;

  const r = await db.abandonedCart.updateMany({
    where: { shopId, token: { in: list }, convertedAt: null },
    data: { convertedAt: new Date() },
  });
  if (r.count) console.log(`[abandoned] ${r.count} carts turned into orders - reminders stopped`);
}
