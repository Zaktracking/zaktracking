import "@shopify/ui-extensions/preact";
import { render } from "preact";

export default function () {
  render(<Extension />, document.body);
}

function Extension() {
  const s = typeof shopify !== "undefined" && shopify.settings ? shopify.settings.value : null;
  const href = s && s.tracking_url ? String(s.tracking_url).trim() : "";
  if (!href) return null;

  return (
    <s-section heading="Track your order">
      <s-stack direction="block" gap="base">
        <s-text>Looking for a parcel? Track any of your orders here.</s-text>
        <s-button href={href} target="_blank" variant="primary">
          Track your order
        </s-button>
      </s-stack>
    </s-section>
  );
}
