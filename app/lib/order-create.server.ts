/**
 * Creating a Cash on Delivery order from our own form.
 *
 * Only COD comes through here. Prepaid never does - that goes to Shopify's
 * own checkout, where Shopify and the payment provider handle the money
 * exactly as they do today. Nothing in this file touches a rupee.
 */

import { unauthenticated } from "../shopify.server";

export type BuyerLine = { variantId: string; quantity: number };

/** A discount already sitting on the shopper's cart, checked against the
 *  real code before it ever reaches an order. */
export type BuyerDiscount = { code: string; amount: number };

export type BuyerInput = {
  items: BuyerLine[];     // one or more gid://shopify/ProductVariant/123
  discount?: BuyerDiscount | null;
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
 * What a discount code is really worth.
 *
 * The shopper's browser tells us which code the cart is carrying. It is not
 * trusted for a rupee: the code is looked up here, and only a live code with
 * a value Shopify itself recognises is ever put on an order. The browser's
 * own figure is used only as a ceiling, never as the number.
 */
export async function discountValue(
  domain: string,
  code: string,
  subtotal: number,
  claimed: number,
): Promise<{ code: string; amount: number } | null> {
  const clean = String(code || "").trim();
  if (!clean || subtotal <= 0) return null;

  try {
    const json = await call(
      domain,
      `#graphql
       query zakDiscount($code: String!) {
         codeDiscountNodeByCode(code: $code) {
           codeDiscount {
             __typename
             ... on DiscountCodeBasic {
               status
               customerGets {
                 value {
                   __typename
                   ... on DiscountPercentage { percentage }
                   ... on DiscountAmount { amount { amount } }
                 }
               }
             }
           }
         }
       }`,
      { code: clean },
    );

    const d = json?.data?.codeDiscountNodeByCode?.codeDiscount;
    if (!d || d.status !== "ACTIVE") return null;

    const v = d.customerGets?.value;
    let amount = 0;
    if (v?.__typename === "DiscountPercentage") {
      amount = (subtotal * (Number(v.percentage) || 0)) / 100;
    } else if (v?.__typename === "DiscountAmount") {
      amount = Number(v.amount?.amount) || 0;
    }

    // Never more than the cart itself claimed, never more than the goods.
    if (claimed > 0) amount = Math.min(amount, claimed);
    amount = Math.min(amount, subtotal);
    amount = Math.round(amount * 100) / 100;

    if (amount <= 0) return null;
    return { code: clean, amount };
  } catch (e: any) {
    console.log(`[buy] could not read the discount code: ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Writes the order. Financial status stays PENDING because no money has
 * moved - that is exactly what Cash on Delivery means, and it is what makes
 * the rest of the app treat it as COD.
 */
export async function createCodOrder(domain: string, b: BuyerInput) {
  // Shopify wants the plus sign; WhatsApp does not, and toE164 is shared
  // with it. So the sign goes back on here rather than there.
  const e164 = b.phone.charAt(0) === "+" ? b.phone : "+" + b.phone.replace(/\D/g, "");

  const order: any = {
    email: b.email || null,
    phone: e164,
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
      phone: e164,
    },
  };
  order.billingAddress = { ...order.shippingAddress };

  if (b.discount && b.discount.amount > 0) {
    order.discountCode = {
      itemFixedDiscountCode: {
        code: b.discount.code,
        amountSet: { shopMoney: { amount: b.discount.amount.toFixed(2), currencyCode: "INR" } },
      },
    };
  }

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
        options: { inventoryBehaviour: "DECREMENT_IGNORING_POLICY", sendReceipt: true },
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
