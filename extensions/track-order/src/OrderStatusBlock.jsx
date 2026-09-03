import "@shopify/ui-extensions/preact";
import { render } from "preact";

/* Order status page. Here the order is real, so the order number travels
   in the link and the shopper only has to add the last 4 digits. */

export default function () {
  render(<Extension />, document.body);
}

function storeBase() {
  var s = typeof shopify !== "undefined" ? shopify.shop : null;
  if (!s) return "";
  if (s.storefrontUrl) return String(s.storefrontUrl).replace(/\/+$/, "");
  if (s.myshopifyDomain) return "https://" + s.myshopifyDomain;
  return "";
}

function Extension() {
  const base = storeBase();
  if (!base) return null;

  const order = shopify.order ? shopify.order.value : null;
  let href = base + "/apps/track";
  if (order && order.name) {
    href += "?order=" + encodeURIComponent(order.name);
  }

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>See where your parcel has reached right now.</s-text>
        <s-button href={href} target="_blank" variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
