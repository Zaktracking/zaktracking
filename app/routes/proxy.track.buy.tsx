/**
 * The order form - zakdor.com/apps/track/buy?v=<variant id>
 *
 * Why a page of our own and not Shopify's checkout: the phone number has to
 * be proved real BEFORE the order exists, and Cash on Delivery has to cost
 * more than paying online. Neither is possible inside Shopify's checkout on
 * this plan.
 *
 * What is deliberately NOT here: taking money. Choosing "Pay online" hands
 * the shopper to Shopify's own checkout with the discount already applied.
 * Every rupee still moves the way it does today.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { shopFromProxy, esc, liquid } from "../lib/proxy.server";
import { toE164 } from "../lib/webhook.server";
import { isVerified } from "../lib/otp.server";
import { variantInfo, createCodOrder, discountValue } from "../lib/order-create.server";

const DEFAULT_PREPAID_OFF = "35";
const DEFAULT_PREPAID_CODE = "PREPAID35";

/** gid or bare number, both accepted from the link. */
function toVariantGid(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("gid://shopify/ProductVariant/")) return s;
  if (/^\d+$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
  return null;
}

function money(n: number): string {
  return "₹" + Math.max(0, Math.round(n)).toLocaleString("en-IN");
}

const CSS = `
<style>
.zb{max-width:560px;margin:0 auto;padding:34px 18px 70px;font-family:inherit;color:inherit}
.zb h1{font-size:26px;font-weight:700;letter-spacing:-.02em;margin:0 0 6px;color:inherit}
.zb .lede{font-size:14px;opacity:.72;margin:0 0 22px}
.zb .card{background:#fff;color:#16181d;border:1px solid #e6e7ea;border-radius:18px;padding:20px;margin-bottom:14px}
.zb .item{display:flex;gap:14px;align-items:center}
.zb .item img{width:62px;height:62px;object-fit:cover;border-radius:12px;flex:0 0 auto;background:#f2f3f5}
.zb .item .t{font-weight:600;font-size:15px;line-height:1.35}
.zb .item .s{font-size:12.5px;color:#65686f;margin-top:3px}
.zb .step{display:flex;align-items:center;gap:9px;font-size:11px;font-weight:700;letter-spacing:.12em;
  text-transform:uppercase;color:#8a8d94;margin:0 0 14px}
.zb .step b{width:20px;height:20px;border-radius:50%;background:#16181d;color:#fff;display:grid;
  place-items:center;font-size:11px;letter-spacing:0}
.zb .row{display:flex;gap:10px}
.zb .row>*{flex:1;min-width:0}
.zb .f{margin-bottom:12px}
.zb label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;
  color:#65686f;margin-bottom:6px}
.zb input,.zb textarea{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:11px;font:inherit;
  font-size:15px;border:1px solid #d3d5da !important;background:#fff !important;color:#16181d !important}
.zb input::placeholder,.zb textarea::placeholder{color:#9aa0a8 !important;opacity:1;font-style:italic}
.zb input:focus,.zb textarea:focus{outline:none;border-color:#16181d !important;
  box-shadow:0 0 0 3px rgba(22,24,29,.08)}
.zb textarea{min-height:74px;resize:vertical}
.zb .btn{position:relative;width:100%;border:0;border-radius:12px;padding:14px 20px;font:inherit;
  font-size:15px;font-weight:650;cursor:pointer;background:#16181d !important;color:#fff !important}
.zb .btn:hover{background:#33363d !important}
.zb .btn[disabled]{opacity:.45;cursor:not-allowed}
.zb .btn.ghost{background:transparent !important;color:#16181d !important;border:1px solid #d3d5da}
.zb .link{background:none;border:0;padding:0;font:inherit;font-size:13px;color:#16181d;
  text-decoration:underline;cursor:pointer}
.zb .pay{display:grid;gap:10px;margin-bottom:16px}
.zb .opt{display:flex;gap:12px;align-items:flex-start;border:1.5px solid #e6e7ea;border-radius:14px;
  padding:14px;cursor:pointer;transition:border-color .15s,background .15s}
.zb .opt:hover{border-color:#c2c5cb}
.zb .opt input{width:18px;height:18px;flex:0 0 auto;margin:2px 0 0;accent-color:#16181d}
.zb .opt.sel{border-color:#16181d;background:#fafafb}
.zb .opt .h{font-weight:650;font-size:14.5px;display:flex;justify-content:space-between;gap:10px}
.zb .opt .d{font-size:12.5px;color:#65686f;margin-top:3px;line-height:1.5}
.zb .save{display:inline-block;background:#eaf7ef;color:#0f7a3d;border-radius:20px;padding:2px 9px;
  font-size:11px;font-weight:700;margin-left:6px;vertical-align:1px}
.zb .msg{border-radius:11px;padding:11px 13px;font-size:13.5px;line-height:1.5;margin:0 0 12px}
.zb .bad{background:#fdeeec;color:#8e1c22}
.zb .good{background:#eaf7ef;color:#0f7a3d}
.zb .ok{display:flex;align-items:center;gap:7px;font-size:13px;color:#0f7a3d;font-weight:600}
.zb .tiny{font-size:12px;color:#65686f;text-align:center;margin-top:14px;line-height:1.6}
.zb .tiny a{color:inherit}
.zb .hide{display:none !important}
.zb .otp{letter-spacing:.42em;font-weight:650;text-align:center}

/* the same two counter-turning arcs the store uses everywhere else */
.zb .busy{color:transparent !important;pointer-events:none}
.zb .busy::after,.zb .busy::before{content:'';position:absolute;top:50%;left:50%;border-radius:50%;
  border-style:solid;border-color:#fff}
.zb .busy::after{width:18px;height:18px;margin:-9px 0 0 -9px;border-width:2px;
  border-right-color:transparent;border-bottom-color:transparent;
  animation:zb-a .92s cubic-bezier(.62,.06,.38,.96) infinite}
.zb .busy::before{width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-width:1.5px;opacity:.5;
  border-left-color:transparent;border-top-color:transparent;animation:zb-b .58s linear infinite}
.zb .btn.ghost.busy::after,.zb .btn.ghost.busy::before{border-color:#16181d;
  border-right-color:transparent;border-bottom-color:transparent}
@keyframes zb-a{to{transform:rotate(360deg)}}
@keyframes zb-b{to{transform:rotate(-360deg)}}
@media (prefers-reduced-motion:reduce){
  .zb .busy::after,.zb .busy::before{animation-duration:1.8s;animation-timing-function:linear}
}
</style>
`;

function page(inner: string) {
  return `${CSS}<div class="zb">${inner}</div>`;
}

function notice(text: string) {
  return page(`<h1>Order</h1><div class="card"><p style="margin:0">${esc(text)}</p></div>`);
}

/* ------------------------------------------------------------------ */
/*  GET - draw the form                                                */
/* ------------------------------------------------------------------ */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const wantsJson = url.searchParams.get("json") === "1";
  const domain = shopFromProxy(url);
  if (!domain) {
    return wantsJson
      ? Response.json({ ok: false, enabled: false })
      : liquid(notice("Something went wrong. Please open the page again."));
  }

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop) {
    return wantsJson
      ? Response.json({ ok: false, enabled: false })
      : liquid(notice("This store is not set up yet."));
  }
  if (!shop.formEnabled) {
    return wantsJson
      ? Response.json({ ok: true, enabled: false })
      : liquid(notice("Ordering through this page is switched off right now."));
  }

  /* The popup in the theme asks for this. It carries no secret - only the
     discount that is already printed on the page, and the product it is
     about to show. */
  if (wantsJson) {
    const offJson = Number(shop.prepaidOff ?? DEFAULT_PREPAID_OFF) || 0;
    const body: any = {
      ok: true,
      enabled: true,
      off: offJson,
      code: shop.prepaidCode || DEFAULT_PREPAID_CODE,
    };

    const askedFor = url.searchParams.get("v");
    if (askedFor) {
      const g = toVariantGid(askedFor);
      const v = g ? await variantInfo(domain, g) : null;
      if (!v) return Response.json({ ...body, item: null, reason: "That product could not be found." });
      if (!v.available) {
        return Response.json({ ...body, item: null, reason: "That product is out of stock right now." });
      }
      body.item = {
        variant: g!.split("/").pop(),
        title:
          v.variantTitle && v.variantTitle !== "Default Title"
            ? `${v.productTitle} - ${v.variantTitle}`
            : v.productTitle,
        price: Number(v.price) || 0,
        image: v.image,
      };
    }

    return Response.json(body);
  }

  const gid = toVariantGid(url.searchParams.get("v") ?? "");
  if (!gid) return liquid(notice("No product was chosen. Please open this page from a product."));

  const qty = Math.min(10, Math.max(1, Number(url.searchParams.get("q") ?? "1") || 1));
  const v = await variantInfo(domain, gid);
  if (!v) return liquid(notice("That product could not be found."));
  if (!v.available) return liquid(notice("That product is out of stock right now."));

  const unit = Number(v.price) || 0;
  const total = unit * qty;
  const off = Number(shop.prepaidOff ?? DEFAULT_PREPAID_OFF) || 0;
  const prepaid = Math.max(0, total - off);
  const numericVariant = gid.split("/").pop() ?? "";
  const code = shop.prepaidCode || DEFAULT_PREPAID_CODE;

  const title = v.variantTitle && v.variantTitle !== "Default Title"
    ? `${v.productTitle} - ${v.variantTitle}`
    : v.productTitle;

  return liquid(
    page(`
<h1>Complete your order</h1>
<p class="lede">Takes under a minute. We send a short code to your number so the parcel reaches the right person.</p>

<div class="card">
  <div class="item">
    ${v.image ? `<img src="${esc(v.image)}" alt="${esc(title)}">` : ""}
    <div>
      <div class="t">${esc(title)}</div>
      <div class="s">Quantity ${qty} &middot; ${esc(money(total))}</div>
    </div>
  </div>
</div>

<form id="zbf" class="card" autocomplete="on" novalidate>
  <div class="step"><b>1</b> Where should it go</div>

  <div class="row">
    <div class="f">
      <label for="fn">First name</label>
      <input id="fn" name="firstName" placeholder="e.g. Rahul" autocomplete="given-name" required>
    </div>
    <div class="f">
      <label for="ln">Last name</label>
      <input id="ln" name="lastName" placeholder="e.g. Kumar" autocomplete="family-name">
    </div>
  </div>

  <div class="f">
    <label for="a1">Address</label>
    <textarea id="a1" name="address1" placeholder="House / street / area" autocomplete="street-address" required></textarea>
  </div>

  <div class="row">
    <div class="f">
      <label for="ct">City</label>
      <input id="ct" name="city" placeholder="e.g. Bettiah" autocomplete="address-level2" required>
    </div>
    <div class="f">
      <label for="zp">PIN code</label>
      <input id="zp" name="zip" placeholder="e.g. 845438" inputmode="numeric" maxlength="6" autocomplete="postal-code" required>
    </div>
  </div>

  <div class="f">
    <label for="em">Email <span style="text-transform:none;font-weight:400">(optional)</span></label>
    <input id="em" name="email" type="email" placeholder="e.g. rahul@gmail.com" autocomplete="email">
  </div>

  <div class="step" style="margin-top:22px"><b>2</b> Confirm your number</div>

  <div class="row">
    <div class="f" style="flex:2">
      <label for="ph">Mobile number</label>
      <input id="ph" name="phone" placeholder="10-digit number" inputmode="numeric" maxlength="14" autocomplete="tel" required>
    </div>
    <div class="f" style="flex:1;display:flex;align-items:flex-end">
      <button type="button" id="send" class="btn ghost">Send code</button>
    </div>
  </div>

  <div id="otpBox" class="f hide">
    <label for="otp">Enter the code we sent you</label>
    <input id="otp" class="otp" name="code" placeholder="------" inputmode="numeric" maxlength="6">
    <div style="margin-top:9px;display:flex;justify-content:space-between;align-items:center;gap:10px">
      <button type="button" id="verify" class="link">Check code</button>
      <button type="button" id="resend" class="link">Send again</button>
    </div>
    <p style="font-size:12px;color:#65686f;margin:8px 0 0">The code comes on WhatsApp, or by SMS if this number is not on WhatsApp.</p>
  </div>

  <div id="verified" class="ok hide">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>
    Number confirmed
  </div>

  <div class="step" style="margin-top:22px"><b>3</b> How would you like to pay</div>

  <div class="pay">
    <label class="opt sel" id="optPre">
      <input type="radio" name="pay" value="prepaid" checked>
      <span style="flex:1">
        <span class="h"><span>Pay online<span class="save">SAVE ${esc(money(off))}</span></span><span>${esc(money(prepaid))}</span></span>
        <span class="d">UPI, card or net banking. Cheaper because there is nothing to collect at the door.</span>
      </span>
    </label>
    <label class="opt" id="optCod">
      <input type="radio" name="pay" value="cod">
      <span style="flex:1">
        <span class="h"><span>Cash on Delivery</span><span>${esc(money(total))}</span></span>
        <span class="d">Pay the delivery agent when the parcel arrives.</span>
      </span>
    </label>
  </div>

  <div id="err" class="msg bad hide"></div>

  <button type="submit" id="go" class="btn">Continue to payment</button>

  <p class="tiny">By ordering you agree to our <a href="/policies/terms-of-service">Terms</a> and
    <a href="/policies/refund-policy">Refund Policy</a>.</p>
</form>

<script>
(function(){
  var f=document.getElementById('zbf');
  var send=document.getElementById('send'), verify=document.getElementById('verify'),
      resend=document.getElementById('resend'), go=document.getElementById('go'),
      otpBox=document.getElementById('otpBox'), okBox=document.getElementById('verified'),
      err=document.getElementById('err'), ph=document.getElementById('ph'), otp=document.getElementById('otp');
  var VARIANT=${JSON.stringify(numericVariant)}, QTY=${qty},
      CODE=${JSON.stringify(code)}, verified=false;

  function busy(b,on){ if(!b) return; b.classList.toggle('busy',!!on); b.disabled=!!on; }
  function fail(m){ err.textContent=m; err.classList.remove('hide'); }
  function clear(){ err.classList.add('hide'); }
  function digits(s){ return String(s||'').replace(/\\D/g,''); }

  function post(body){
    return fetch('/apps/track/otp',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)}).then(function(r){return r.json();});
  }

  function ask(){
    clear();
    var p=digits(ph.value);
    if(p.length<10){ fail('Enter your 10-digit mobile number'); ph.focus(); return; }
    busy(send,true); busy(resend,true);
    post({intent:'send',phone:p}).then(function(r){
      busy(send,false); busy(resend,false);
      if(!r||!r.ok){ fail((r&&r.reason)||'Could not send the code'); return; }
      otpBox.classList.remove('hide'); otp.focus();
      send.textContent='Sent';
    }).catch(function(){ busy(send,false); busy(resend,false); fail('Network problem. Try again.'); });
  }

  send.addEventListener('click',ask);
  resend.addEventListener('click',ask);

  verify.addEventListener('click',function(){
    clear();
    var c=digits(otp.value);
    if(c.length!==6){ fail('Enter the 6-digit code'); return; }
    busy(verify,true);
    post({intent:'verify',phone:digits(ph.value),code:c}).then(function(r){
      busy(verify,false);
      if(!r||!r.ok){ fail((r&&r.reason)||'Wrong code'); return; }
      verified=true; otpBox.classList.add('hide'); okBox.classList.remove('hide');
      send.classList.add('hide');
    }).catch(function(){ busy(verify,false); fail('Network problem. Try again.'); });
  });

  Array.prototype.forEach.call(f.querySelectorAll('input[name=pay]'),function(r){
    r.addEventListener('change',function(){
      document.getElementById('optPre').classList.toggle('sel',r.value==='prepaid'&&r.checked);
      document.getElementById('optCod').classList.toggle('sel',r.value==='cod'&&r.checked);
      go.textContent = (f.pay.value==='cod') ? 'Place order' : 'Continue to payment';
    });
  });

  f.addEventListener('submit',function(e){
    e.preventDefault(); clear();

    var need=['firstName','address1','city','zip'];
    for(var i=0;i<need.length;i++){
      if(!String(f[need[i]].value||'').trim()){ fail('Please fill in every box marked above'); f[need[i]].focus(); return; }
    }
    if(digits(f.zip.value).length!==6){ fail('PIN code must be 6 digits'); f.zip.focus(); return; }
    if(!verified){ fail('Please confirm your mobile number first'); ph.focus(); return; }

    busy(go,true);

    if(f.pay.value==='prepaid'){
      // Shopify's own checkout takes it from here, discount already applied.
      fetch('/cart/add.js',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({items:[{id:Number(VARIANT),quantity:QTY}]})})
        .then(function(){ window.location.href='/checkout?discount='+encodeURIComponent(CODE); })
        .catch(function(){ busy(go,false); fail('Could not open checkout. Please try again.'); });
      return;
    }

    var body={intent:'place',variant:VARIANT,quantity:QTY,
      firstName:f.firstName.value,lastName:f.lastName.value,address1:f.address1.value,
      city:f.city.value,zip:digits(f.zip.value),email:f.email.value,phone:digits(ph.value)};

    fetch('/apps/track/buy',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(r){
      if(!r||!r.ok){ busy(go,false); fail((r&&r.reason)||'Could not place the order'); return; }
      window.location.href='/apps/track?order='+encodeURIComponent(r.name)+'&pin='+encodeURIComponent(digits(ph.value).slice(-4));
    }).catch(function(){ busy(go,false); fail('Network problem. Please try again.'); });
  });
})();
</script>
`),
  );
};

/* ------------------------------------------------------------------ */
/*  POST - place the Cash on Delivery order                            */
/* ------------------------------------------------------------------ */

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const domain = shopFromProxy(url);
  if (!domain) return Response.json({ ok: false, reason: "Unknown shop" }, { status: 400 });

  const shop = await db.shop.findUnique({ where: { domain } });
  if (!shop || !shop.formEnabled) {
    return Response.json({ ok: false, reason: "Ordering is switched off" }, { status: 400 });
  }

  const d = (await request.json().catch(() => ({}))) as any;

  /* One product from a product page, or the whole cart. Both arrive here. */
  const raw: any[] = Array.isArray(d.items)
    ? d.items
    : [{ variant: d.variant, quantity: d.quantity }];

  const items: { variantId: string; quantity: number }[] = [];
  for (const line of raw.slice(0, 20)) {
    const g = toVariantGid(String(line?.variant ?? ""));
    if (!g) continue;
    items.push({ variantId: g, quantity: Math.min(10, Math.max(1, Number(line?.quantity) || 1)) });
  }

  const phone = toE164(String(d.phone ?? ""));
  const zip = String(d.zip ?? "").replace(/\D/g, "");

  if (!items.length) return Response.json({ ok: false, reason: "No product chosen" });
  if (!phone) return Response.json({ ok: false, reason: "Enter a valid mobile number" });
  if (zip.length !== 6) return Response.json({ ok: false, reason: "PIN code must be 6 digits" });
  if (!String(d.firstName ?? "").trim() || !String(d.address1 ?? "").trim() || !String(d.city ?? "").trim()) {
    return Response.json({ ok: false, reason: "Please fill in every box" });
  }

  // The gate. Without this the whole form is just a way for anyone to write
  // orders into the shop from the open internet.
  if (!(await isVerified(shop.id, phone))) {
    return Response.json({ ok: false, reason: "Please confirm your mobile number first" });
  }

  // Whatever the cart was carrying, checked against the real code.
  let discount = null;
  if (d.discountCode) {
    discount = await discountValue(
      domain,
      String(d.discountCode),
      Number(d.subtotal) || 0,
      Number(d.discountAmount) || 0,
    );
    if (discount) console.log(`[buy] ${discount.code} worth ${discount.amount}`);
  }

  const res = await createCodOrder(domain, {
    items,
    discount,
    firstName: String(d.firstName).trim().slice(0, 60),
    lastName: String(d.lastName ?? "").trim().slice(0, 60),
    phone,
    email: String(d.email ?? "").trim().slice(0, 120) || null,
    address1: String(d.address1).trim().slice(0, 200),
    city: String(d.city).trim().slice(0, 60),
    zip,
    note: "Placed on the store's own order form, phone verified by a one-time code",
  });

  if (!res.ok) return Response.json({ ok: false, reason: res.error });

  return Response.json({ ok: true, name: res.name });
};
