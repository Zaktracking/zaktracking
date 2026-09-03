import "@shopify/ui-extensions/preact";
import { render } from "preact";

/* Thank you page. The order does not exist yet at this moment, so there is
   nothing to look up - just the way to the tracking page. */

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

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>Follow your parcel from our warehouse to your door.</s-text>
        <s-button href={base + "/apps/track"} variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
