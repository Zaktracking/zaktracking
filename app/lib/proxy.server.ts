/**
 * Small helpers for the app proxy.
 *
 * We do not check the signature ourselves - the template's
 * `authenticate.public.appProxy(request)` already does that job, and
 * Shopify maintains it. Writing our own HMAC would only be one more
 * place where things can go wrong.
 */

export function shopFromProxy(url: URL): string | null {
  return url.searchParams.get("shop");
}

/** Run this before putting anything into HTML. We strip Liquid's `{` too,
 *  or a customer could put a Liquid tag in their name and toy with the theme. */
export function esc(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/** The app proxy response. Serving application/liquid makes Shopify place
 *  it between the theme header and footer - the page looks like the store
 *  on its own, with nothing extra to do. */
export function liquid(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "application/liquid",
      "Cache-Control": "no-store",
    },
  });
}
