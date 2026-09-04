import "@shopify/ui-extensions/preact";
import { render } from "preact";

/* The Thank you page, the moment the money goes through.
 *
 * A COD order never leaves our own form, so it can show its tick and then
 * send the customer to /account/orders by itself. A paid order cannot:
 * it ends on Shopify's page, and Shopify gives a thank-you extension no
 * navigation at all - the one API that exists, in customer accounts, says
 * plainly that it cannot reach the storefront. So this lands in the same
 * place, it just needs a thumb: same words, same tick, same orders page.
 *
 * The order number is left out on purpose. Shopify prints the real one
 * directly above this block; the only number an extension can read here
 * is the confirmation code, which is a different number entirely, and two
 * different numbers on one screen is how support tickets start. */

export default function () {
  render(<Extension />, document.body);
}

function storeBase() {
  const s = typeof shopify !== "undefined" ? shopify.shop : null;
  if (!s) return "";
  if (s.storefrontUrl) return String(s.storefrontUrl).replace(/\/+$/, "");
  if (s.myshopifyDomain) return "https://" + s.myshopifyDomain;
  return "";
}

function Extension() {
  const base = storeBase();
  if (!base) return null;

  const first = shopify.orderConfirmation.value?.isFirstOrder;

  return (
    <s-banner tone="success" heading="Order complete">
      <s-stack direction="block" gap="base">
        <s-text>
          {first
            ? "Payment received, and thank you for your first order. We will message you on WhatsApp at every step - confirmed, packed, shipped, out for delivery."
            : "Payment received. We will message you on WhatsApp at every step - confirmed, packed, shipped, out for delivery."}
        </s-text>
        <s-stack direction="inline" gap="base">
          <s-button href={base + "/account/orders"} variant="primary">
            Go to my orders
          </s-button>
          <s-button href={base + "/apps/track"} variant="secondary">
            Track your order
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}
