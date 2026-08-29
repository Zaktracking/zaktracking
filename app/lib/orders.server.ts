/**
 * The small part of the Shopify Admin API we actually need after an order
 * already exists: put a tag on it, take a tag off, ask whether it has
 * shipped, and - only when the merchant has allowed it - cancel it.
 *
 * These run from a webhook or from the cron, where there is no logged-in
 * merchant in front of us. `unauthenticated.admin` uses the offline token
 * stored at install time, which is exactly what that is for.
 */

import { unauthenticated } from "../shopify.server";

/** "9876543210" -> "gid://shopify/Order/9876543210" */
function orderGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/Order/${id}`;
}

async function call(domain: string, query: string, variables: any) {
  const { admin } = await unauthenticated.admin(domain);
  const res = await admin.graphql(query, { variables });
  return (await res.json()) as any;
}

/* ------------------------------------------------------------------ */
/*  Tags                                                               */
/* ------------------------------------------------------------------ */

/**
 * Tags are how the merchant sees this in Shopify itself, without opening
 * our app. An order tagged `cod-cancel-requested` can be filtered for in
 * the orders list like any other tag.
 */
export async function tagOrder(
  domain: string,
  shopifyOrderId: string,
  add: string[] = [],
  remove: string[] = [],
) {
  const id = orderGid(shopifyOrderId);

  try {
    if (remove.length) {
      await call(
        domain,
        `#graphql
         mutation zakTagsRemove($id: ID!, $tags: [String!]!) {
           tagsRemove(id: $id, tags: $tags) { userErrors { message } }
         }`,
        { id, tags: remove },
      );
    }
    if (add.length) {
      await call(
        domain,
        `#graphql
         mutation zakTagsAdd($id: ID!, $tags: [String!]!) {
           tagsAdd(id: $id, tags: $tags) { userErrors { message } }
         }`,
        { id, tags: add },
      );
    }
    return { ok: true as const };
  } catch (e: any) {
    console.log(`[orders] could not tag ${shopifyOrderId}: ${e?.message ?? e}`);
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}

/* ------------------------------------------------------------------ */
/*  Current state                                                      */
/* ------------------------------------------------------------------ */

export type OrderState = {
  cancelledAt: string | null;
  fulfillment: string;   // UNFULFILLED | PARTIALLY_FULFILLED | FULFILLED | ...
  financial: string;     // PENDING | PAID | ...
};

/**
 * Read before cancelling, never assume. Our own copy of the order can be
 * minutes old, and in those minutes the parcel may have been handed to the
 * courier.
 */
export async function orderState(
  domain: string,
  shopifyOrderId: string,
): Promise<OrderState | null> {
  try {
    const json = await call(
      domain,
      `#graphql
       query zakOrderState($id: ID!) {
         order(id: $id) {
           cancelledAt
           displayFulfillmentStatus
           displayFinancialStatus
         }
       }`,
      { id: orderGid(shopifyOrderId) },
    );

    const o = json?.data?.order;
    if (!o) return null;

    return {
      cancelledAt: o.cancelledAt ?? null,
      fulfillment: String(o.displayFulfillmentStatus ?? ""),
      financial: String(o.displayFinancialStatus ?? ""),
    };
  } catch (e: any) {
    console.log(`[orders] could not read ${shopifyOrderId}: ${e?.message ?? e}`);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Cancel                                                             */
/* ------------------------------------------------------------------ */

/**
 * Cancelling an order in Shopify cannot be undone. There is no
 * "uncancel" - a mistake means creating a fresh order with a new number.
 *
 * That is the whole reason the customer's Cancel button does not cancel
 * anything straight away. It only records a request; this runs later, once
 * the grace period has passed and the customer has not changed their mind.
 *
 * restock is true so the stock comes back. refund is false because this
 * path is only ever used for Cash on Delivery, where no money has moved.
 */
export async function cancelOrder(
  domain: string,
  shopifyOrderId: string,
  staffNote: string,
) {
  try {
    const json = await call(
      domain,
      `#graphql
       mutation zakOrderCancel(
         $orderId: ID!
         $reason: OrderCancelReason!
         $refund: Boolean!
         $restock: Boolean!
         $notifyCustomer: Boolean
         $staffNote: String
       ) {
         orderCancel(
           orderId: $orderId
           reason: $reason
           refund: $refund
           restock: $restock
           notifyCustomer: $notifyCustomer
           staffNote: $staffNote
         ) {
           orderCancelUserErrors { field message }
           userErrors { field message }
         }
       }`,
      {
        orderId: orderGid(shopifyOrderId),
        reason: "CUSTOMER",
        refund: false,
        restock: true,
        // Our own cancellation message goes out from the orders/cancelled
        // webhook. Letting Shopify email as well would say the same thing twice.
        notifyCustomer: false,
        staffNote,
      },
    );

    const errs = [
      ...(json?.data?.orderCancel?.orderCancelUserErrors ?? []),
      ...(json?.data?.orderCancel?.userErrors ?? []),
    ];

    if (errs.length) {
      const msg = errs.map((e: any) => e.message).join("; ");
      console.log(`[orders] cancel refused for ${shopifyOrderId}: ${msg}`);
      return { ok: false as const, error: msg };
    }

    console.log(`[orders] cancelled ${shopifyOrderId}`);
    return { ok: true as const };
  } catch (e: any) {
    console.log(`[orders] cancel failed for ${shopifyOrderId}: ${e?.message ?? e}`);
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}
