/**
 * Creating a Cash on Delivery order from our own form.
 *
 * Only COD comes through here. Prepaid never does - that goes to Shopify's
 * own checkout, where Shopify and the payment provider handle the money
 * exactly as they do today. Nothing in this file touches a rupee.
 */

import { unauthenticated } from "../shopify.server";

export type BuyerLine = { variantId: string; quantity: number };

export type BuyerInput = {
  items: BuyerLine[];     // one or more gid://shopify/ProductVariant/123
  firstName: string;
  lastName: string;
  phone: string;          // E.164, already verified by OTP
  email?: string | null;
  address1: string;
  address2?: string | null;
  city: string;
  province?: string | null;
  zip: string;
  note?: string | null;
};

async function call(domain: string, query: string, variables: any) {
  const { admin } = await unauthenticated.admin(domain);
  const res = await admin.graphql(query, { variables });
  return (await res.json()) as any;
}

/** Price and title of one variant, for showing on the form. */
export async function variantInfo(domain: string, variantId: string) {
  try {
    const json = await call(
      domain,
      `#graphql
       query zakVariant($id: ID!) {
         productVariant(id: $id) {
           id
           title
           price
           compareAtPrice
           availableForSale
           image { url altText }
           product { title handle featuredMedia { preview { image { url altText } } } }
         }
       }`,
      { id: variantId },
    );
    const v = json?.data?.productVariant;
    if (!v) return null;

    return {
      id: v.id as string,
      variantTitle: String(v.title ?? ""),
      productTitle: String(v.product?.title ?? ""),
      handle: String(v.product?.handle ?? ""),
      price: String(v.price ?? "0"),
      compareAt: v.compareAtPrice ? String(v.compareAtPrice) : null,
      available: Boolean(v.availableForSale),
      image:
        v.image?.url ??
        v.product?.featuredMedia?.preview?.image?.url ??
        null,
    };
  } catch (e: any) {
    console.log(`[buy] could not read variant: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Writes the order. Financial status stays PENDING because no money has
 * moved - that is exactly what Cash on Delivery means, and it is what makes
 * the rest of the app treat it as COD.
 */
export async function createCodOrder(domain: string, b: BuyerInput) {
  const order: any = {
    email: b.email || null,
    phone: b.phone,
    financialStatus: "PENDING",
    tags: "Cash on Delivery, zaktracking-form, otp-verified",
    note: b.note || null,
    customAttributes: [{ key: "Phone verified", value: "Yes, by a one-time code" }],
    lineItems: b.items.map((l) => ({
      variantId: l.variantId,
      quantity: Math.max(1, Math.min(10, Number(l.quantity) || 1)),
    })),
    shippingAddress: {
      firstName: b.firstName,
      lastName: b.lastName || "-",
      address1: b.address1,
      address2: b.address2 || null,
      city: b.city,
      provinceCode: b.province || null,
      zip: b.zip,
      countryCode: "IN",
      phone: b.phone,
    },
  };
  order.billingAddress = { ...order.shippingAddress };

  try {
    const json = await call(
      domain,
      `#graphql
       mutation zakOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
         orderCreate(order: $order, options: $options) {
           order { id name }
           userErrors { field message }
         }
       }`,
      {
        order,
        options: { inventoryBehaviour: "DECREMENT_OBLIGATORY", sendReceipt: true },
      },
    );

    const errs = json?.data?.orderCreate?.userErrors ?? [];
    if (errs.length) {
      const msg = errs.map((e: any) => e.message).join("; ");
      console.log(`[buy] order refused: ${msg}`);
      return { ok: false as const, error: msg };
    }

    const created = json?.data?.orderCreate?.order;
    if (!created?.id) {
      return { ok: false as const, error: "Order was not created" };
    }

    console.log(`[buy] created ${created.name}`);
    return { ok: true as const, id: created.id as string, name: created.name as string };
  } catch (e: any) {
    console.log(`[buy] order failed: ${e?.message ?? e}`);
    return { ok: false as const, error: "Could not place the order. Please try again." };
  }
}
