import { useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useActionData, Form } from "react-router";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureShop, toE164 } from "../lib/webhook.server";
import { checkCredentials, listTemplates, sendTemplate, templateSpec } from "../lib/whatsapp.server";
import { EVENTS, blankVars } from "../lib/templates.server";

/**
 * Admin page.
 *
 * Polaris is deliberately not used here. The new Shopify template does
 * not ship @shopify/polaris at all, and pulling in two heavy packages
 * just for this one page and wiring up their CSS/AppProvider - that
 * raises the risk for the whole app. Plain HTML works in every template.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [messages, orders, queued, parcels, tracked] = await Promise.all([
    db.messageLog.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.orderRecord.count({ where: { shopId: shop.id } }),
    db.messageLog.count({ where: { shopId: shop.id, status: "queued" } }),
    db.shipment.findMany({
      where: { order: { shopId: shop.id } },
      orderBy: { updatedAt: "desc" },
      take: 10,
      include: { order: true },
    }),
    db.shipment.count({ where: { order: { shopId: shop.id }, registered: true } }),
  ]);

  // The merchant's inbox. A Cloud API number cannot be opened in the normal
  // WhatsApp Business app, so this table is the only place replies exist.
  const replies = await db.inboundMessage.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { order: { select: { orderNumber: true } } },
  });

  const awaitingCancel = await db.orderRecord.findMany({
    where: { shopId: shop.id, cancelRequestedAt: { not: null }, cancelledAt: null },
    orderBy: { cancelRequestedAt: "asc" },
    take: 20,
  });

  let live: any = null;
  let templates: any[] = [];
  if (shop.waToken && shop.waPhoneNumberId) {
    live = await checkCredentials(shop.waPhoneNumberId, shop.waToken);
    if (shop.waWabaId) {
      const t = await listTemplates(shop.waWabaId, shop.waToken);
      if (t.ok) templates = t.templates;
    }
  }

  // Which of our templates are not approved yet.
  //
  // This has to be worked out HERE, not in the component. EVENTS lives in
  // templates.server.ts, and React Router only strips server-only imports
  // that nothing outside loader/action touches. Reading it from the
  // component pulled the whole server module into the browser bundle, the
  // page stopped hydrating, and every button on it went dead.
  const approved = new Set(
    templates.filter((t: any) => t.status === "APPROVED").map((t: any) => t.name),
  );
  const missing = Array.from(new Set(Object.values(EVENTS).map((e) => e.template)))
    .filter((n) => !approved.has(n));

  // How many {{n}} the template really has, next to how many the app holds
  // for it. When those two numbers disagree the message is refused with
  // 132000 and the customer gets nothing - so it is worth seeing here
  // rather than finding out from a failed send.
  const blank = blankVars();
  const ours = new Map<string, number>();
  const oursOld = new Map<string, number>();
  for (const def of Object.values(EVENTS)) {
    ours.set(def.template, def.params(blank).length);
    if (def.old) oursOld.set(def.template, def.old(blank).length);
  }

  function bodyVarsOf(t: any): number {
    let n = 0;
    for (const comp of t?.components ?? []) {
      if (String(comp?.type ?? "").toUpperCase() !== "BODY") continue;
      for (const m of String(comp?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
        n = Math.max(n, Number(m[1]));
      }
    }
    return n;
  }

  const templateList = templates
    .map((t: any) => ({
      name: t.name,
      status: t.status,
      language: t.language,
      needs: bodyVarsOf(t),
      sends: ours.has(t.name) ? ours.get(t.name)! : null,
      sendsOld: oursOld.get(t.name) ?? null,
    }))
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

  // The keys never leave the server whole. The page shows their last four
  // characters - enough to tell one key from another, useless to anyone
  // reading the page's data in the browser.
  const mask = (v: string | null) => (v ? "\u2022\u2022\u2022\u2022" + v.slice(-4) : "");
  const safeShop = {
    ...shop,
    waToken: mask(shop.waToken),
    smsApiKey: mask(shop.smsApiKey),
    trackApiKey: mask(shop.trackApiKey),
    rzpKeySecret: mask(shop.rzpKeySecret),
  };

  return {
    shop: safeShop, messages, orders, queued, live, missing, templateList, parcels, tracked,
    replies, awaitingCancel,
    domain: session.shop,
    appUrl: process.env.SHOPIFY_APP_URL ?? "",
    cronSet: Boolean(process.env.CRON_SECRET),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const fd = await request.formData();
  // The settings form carries intent=save, and each Remove button adds an
  // intent of its own when it is the one pressed - that one wins.
  const intents = fd.getAll("intent").map(String);
  const intent = intents.find((i) => i.startsWith("remove:")) ?? intents[0] ?? "";

  console.log(`[admin] action reached: intent="${intent}" shop=${session.shop}`);

  if (intent.startsWith("remove:")) {
    const key = intent.slice(7);
    const allowed: Record<string, string> = {
      waToken: "WhatsApp token", smsApiKey: "Fast2SMS key", trackApiKey: "17TRACK key",
      rzpKeySecret: "Razorpay key secret",
    };
    if (!allowed[key]) return { ok: false, msg: "Could not understand that request" };
    await db.shop.update({ where: { id: shop.id }, data: { [key]: null } });
    console.log(`[admin] removed ${key}`);
    return { ok: true, msg: `${allowed[key]} removed` };
  }

  if (intent === "save") {
    const str = (k: string) => {
      const v = String(fd.get(k) ?? "").trim();
      return v === "" ? null : v;
    };
    const on = (k: string) => fd.get(k) === "on";

    await db.shop.update({
      where: { id: shop.id },
      data: {
        waPhoneNumberId: str("waPhoneNumberId"),
        waWabaId: str("waWabaId"),
        // If the token is left empty we keep the old one - otherwise it would
        // have to be pasted on every save, and one slip would stop everything.
        waToken: str("waToken") ?? shop.waToken,
        trackApiKey: str("trackApiKey") ?? shop.trackApiKey,
        abandonCode: str("abandonCode"),
        otpTemplate: str("otpTemplate"),
        otpChannel: str("otpChannel"),
        smsEnabled: on("smsEnabled"),
        smsApiKey: str("smsApiKey") ?? shop.smsApiKey,
        smsSenderId: str("smsSenderId"),
        smsRoute: str("smsRoute"),
        formEnabled: on("formEnabled"),
        prepaidCode: str("prepaidCode"),
        rzpKeyId: str("rzpKeyId"),
        rzpKeySecret: str("rzpKeySecret") ?? shop.rzpKeySecret,
        waEnabled: on("waEnabled"),
        onOrderCreate: on("onOrderCreate"),
        codConfirm: on("codConfirm"),
        onCodConfirm: on("onCodConfirm"),
        onCodReminder: on("onCodReminder"),
        onCodConfirmed: on("onCodConfirmed"),
        codReminderHours: Math.min(48, Math.max(1, Number(fd.get("codReminderHours")) || 6)),
        autoConfirm: on("autoConfirm"),
        autoConfirmMin: Math.min(1440, Math.max(5, Number(fd.get("autoConfirmMin")) || 30)),
        // Stored the way WhatsApp writes a number - 91 and ten digits, no
        // plus - so it compares straight against the sender of a reply.
        ownerPhone: toE164(str("ownerPhone") ?? "") ?? null,
        ownerAlerts: on("ownerAlerts"),
        onOrderPaid: on("onOrderPaid"),
        onFulfilled: on("onFulfilled"),
        onInTransit: on("onInTransit"),
        onOutForDelivery: on("onOutForDelivery"),
        onDelivered: on("onDelivered"),
        onCancelled: on("onCancelled"),
        onAbandoned: on("onAbandoned"),
        autoCancel: on("autoCancel"),
        cancelGraceMin: Math.min(
          720,
          Math.max(5, Number(fd.get("cancelGraceMin")) || 30),
        ),
      },
    });
    const after = await db.shop.findUnique({ where: { id: shop.id } });
    console.log(
      `[admin] saved -> phoneNumberId=${after?.waPhoneNumberId ?? "null"}` +
        ` wabaId=${after?.waWabaId ?? "null"}` +
        ` token=${after?.waToken ? "set" : "null"}` +
        ` trackKey=${after?.trackApiKey ? "set" : "null"}` +
        ` enabled=${after?.waEnabled}`,
    );

    return { ok: true, msg: "Settings saved" };
  }

  if (intent === "test") {
    const to = toE164(String(fd.get("testTo") || ""));
    const fresh = await db.shop.findUnique({ where: { id: shop.id } });

    if (!to) {
      console.log("[admin] test: that number does not look right");
      return { ok: false, msg: "That number does not look right" };
    }
    if (!fresh?.waToken || !fresh?.waPhoneNumberId) {
      console.log("[admin] test: phone number ID or token is missing");
      return { ok: false, msg: "Enter the phone number ID and token first, then save" };
    }

    const name = String(fd.get("testTemplate") || "hello_world").trim();

    // Read what the template actually needs instead of assuming five body
    // variables. hello_world takes none; sending five would fail with 132000
    // and look like a different problem entirely.
    const spec = fresh.waWabaId
      ? await templateSpec(fresh.waWabaId, fresh.waToken, name)
      : null;

    if (fresh.waWabaId && !spec) {
      const msg = `No template named "${name}" in this WhatsApp account`;
      console.log(`[admin] test -> ${msg}`);
      return { ok: false, msg };
    }
    if (spec && spec.status !== "APPROVED") {
      const msg = `Template "${name}" is ${spec.status}, not APPROVED - Meta will not send it yet`;
      console.log(`[admin] test -> ${msg}`);
      return { ok: false, msg };
    }

    const SAMPLES = [
      "Sadik", "Z1005", "Portable Blender", "899", "14 September",
      "Delhivery", "1234567890", "Patna", "Bettiah, Bihar 845438", "WELCOME10",
    ];
    const params = SAMPLES.slice(0, spec?.bodyVars ?? 0);

    const res = await sendTemplate({
      phoneNumberId: fresh.waPhoneNumberId,
      token: fresh.waToken,
      wabaId: fresh.waWabaId,
      to,
      template: name,
      language: spec?.language,
      params,
      buttonParam: spec?.urlVar ? "test123" : null,
    });

    // Printed to the terminal as well as returned to the page. Whatever Meta
    // says here is the only thing that explains a message that never arrives,
    // and hunting for a banner in an embedded iframe is no way to read it.
    console.log(
      res.ok
        ? `[admin] test -> Meta accepted it, id ${res.id}`
        : `[admin] test -> REJECTED by Meta: ${res.error}`,
    );

    return res.ok
      ? { ok: true, msg: `Sent. Check your WhatsApp (id ${res.id.slice(-8)})` }
      : { ok: false, msg: res.error };
  }

  return { ok: false, msg: "Could not understand that request" };
};

/* ------------------------------------------------------------------ */
/*  small UI pieces                                                    */
/* ------------------------------------------------------------------ */

const S = {
  page: { maxWidth: 860, margin: "0 auto", padding: "24px 16px 80px",
    font: "14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
    color: "#1a1a1a" } as React.CSSProperties,
  card: { background: "#fff", border: "1px solid #e3e3e3", borderRadius: 12,
    padding: 20, marginBottom: 16, boxShadow: "0 1px 2px rgba(0,0,0,.04)" } as React.CSSProperties,
  h2: { margin: "0 0 14px", fontSize: 16, fontWeight: 650 } as React.CSSProperties,
  label: { display: "block", fontSize: 13, fontWeight: 550, marginBottom: 5 } as React.CSSProperties,
  input: { width: "100%", padding: "9px 11px", border: "1px solid #8a8a8a",
    borderRadius: 8, fontSize: 14, boxSizing: "border-box" } as React.CSSProperties,
  help: { fontSize: 12, color: "#616161", margin: "5px 0 0" } as React.CSSProperties,
  field: { marginBottom: 16 } as React.CSSProperties,
  btn: { background: "#303030", color: "#fff", border: 0, borderRadius: 8,
    padding: "9px 18px", fontSize: 14, fontWeight: 550, cursor: "pointer" } as React.CSSProperties,
  row: { display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 } as React.CSSProperties,
  stat: { flex: "1 1 170px", background: "#fff", border: "1px solid #e3e3e3",
    borderRadius: 12, padding: "16px 18px" } as React.CSSProperties,
  muted: { color: "#616161", fontSize: 12, margin: 0 } as React.CSSProperties,
  big: { fontSize: 22, fontWeight: 650, margin: "4px 0 0" } as React.CSSProperties,
  th: { textAlign: "left", fontSize: 12, color: "#616161", fontWeight: 550,
    padding: "8px 10px", borderBottom: "1px solid #e3e3e3" } as React.CSSProperties,
  td: { padding: "9px 10px", borderBottom: "1px solid #f1f1f1", verticalAlign: "top" } as React.CSSProperties,
  code: { background: "#f1f1f1", borderRadius: 5, padding: "1px 6px",
    fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace", fontSize: 12 } as React.CSSProperties,
};

function Banner({ tone, title, children }:
  { tone: "success" | "critical" | "warning"; title?: string; children?: any }) {
  const c = tone === "success" ? { bg: "#e6f6ec", bd: "#0f7a3d" }
    : tone === "critical" ? { bg: "#fdeceb", bd: "#c4262e" }
    : { bg: "#fff4e4", bd: "#b98900" };
  return (
    <div style={{ background: c.bg, borderLeft: `4px solid ${c.bd}`, borderRadius: 10,
      padding: "12px 16px", marginBottom: 16 }}>
      {title && <p style={{ margin: "0 0 4px", fontWeight: 650 }}>{title}</p>}
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

function Pill({ status }: { status: string }) {
  const c = status === "sent" ? { bg: "#e6f6ec", fg: "#0b5c2e" }
    : status === "failed" ? { bg: "#fdeceb", fg: "#8e1c22" }
    : { bg: "#fff4e4", fg: "#7a5a00" };
  const t = status === "sent" ? "Sent" : status === "failed" ? "Failed" : "Queued";
  return <span style={{ background: c.bg, color: c.fg, borderRadius: 20,
    padding: "2px 10px", fontSize: 12, fontWeight: 600 }}>{t}</span>;
}

function Text({ label, name, defaultValue, placeholder, help, type }: any) {
  return (
    <div style={S.field}>
      <label style={S.label} htmlFor={name}>{label}</label>
      <input style={S.input} id={name} name={name} type={type ?? "text"}
        defaultValue={defaultValue} placeholder={placeholder} autoComplete="off" />
      {help && <p style={S.help}>{help}</p>}
    </div>
  );
}

function Check({ label, name, defaultChecked, help }: any) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
        <input type="checkbox" name={name} defaultChecked={defaultChecked}
          style={{ marginTop: 3, width: 16, height: 16 }} />
        <span>
          <span style={{ fontWeight: 550 }}>{label}</span>
          {help && <span style={{ display: "block", ...S.help }}>{help}</span>}
        </span>
      </label>
    </div>
  );
}

/**
 * A key that is already stored. The page never has the whole key - only
 * its last four characters - so there is nothing to show but those, a
 * Change button that opens a box for a new one, and a Remove button.
 * Leaving the box empty on Save keeps the stored key.
 */
function Secret({ label, name, masked, help }: any) {
  const [edit, setEdit] = useState(!masked);
  const small = { ...S.btn, padding: "6px 12px", fontSize: 13 } as React.CSSProperties;
  return (
    <div style={S.field}>
      <label style={S.label} htmlFor={name}>{label}</label>
      {edit ? (
        <input style={S.input} id={name} name={name} type="password" autoComplete="off"
          placeholder={masked ? "paste the new one, or leave empty to keep the current one" : "not set yet"} />
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <code style={{ ...S.code, padding: "6px 10px" }}>{masked}</code>
          <button type="button" style={small} onClick={() => setEdit(true)}>Change</button>
          <button type="submit" name="intent" value={`remove:${name}`}
            style={{ ...small, background: "#fff", color: "#8e1c22", border: "1px solid #8e1c22" }}
            onClick={(e) => { if (!window.confirm(`Remove the stored ${label}?`)) e.preventDefault(); }}>
            Remove
          </button>
        </div>
      )}
      {help && <p style={S.help}>{help}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Index() {
  const { shop, messages, orders, queued, live, missing, templateList, parcels,
    tracked, domain, appUrl, cronSet, replies, awaitingCancel } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  // The settings form is a plain <Form>, so its result comes back through
  // useActionData, not through the fetcher. Without this the Save button
  // gave no feedback at all - it looked like nothing had happened.
  const actionData = useActionData<typeof action>();
  const result = fetcher.data ?? actionData;
  const [testTo, setTestTo] = useState("");

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 18px" }}>ZakTracking</h1>

      {result && (
        <Banner tone={result.ok ? "success" : "critical"}>{result.msg}</Banner>
      )}

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <div style={S.stat}>
          <p style={S.muted}>Orders</p>
          <p style={S.big}>{orders}</p>
        </div>
        <div style={S.stat}>
          <p style={S.muted}>In queue</p>
          <p style={S.big}>{queued}</p>
        </div>
        <div style={S.stat}>
          <p style={S.muted}>Parcels in tracking</p>
          <p style={S.big}>{tracked}</p>
        </div>
        <div style={S.stat}>
          <p style={S.muted}>WhatsApp</p>
          <p style={S.big}>{live?.ok ? live.number : shop.waEnabled ? "Error" : "Off"}</p>
          {live?.ok && (
            <p style={S.muted}>{live.name} · quality {live.quality ?? "-"}</p>
          )}
        </div>
      </div>

      {live && !live.ok && (
        <Banner tone="critical" title="Cannot reach WhatsApp">
          <p style={{ margin: "0 0 4px" }}>{live.error}</p>
          <p style={{ margin: 0 }}>
            The token may have expired. Create a new one from a system user in
            Business settings and paste it here.
          </p>
        </Banner>
      )}

      {live?.ok && missing.length > 0 && (
        <Banner tone="warning" title={`${missing.length} templates are not approved yet`}>
          <p style={{ margin: "0 0 4px" }}>{missing.join(", ")}</p>
          <p style={{ margin: 0 }}>
            Templates that are not approved cannot be sent. Check WhatsApp Manager.
          </p>
        </Banner>
      )}

      <div style={S.card}>
        <Form method="post">
          <input type="hidden" name="intent" value="save" />
          <h2 style={S.h2}>WhatsApp connection</h2>

          <Text label="Phone number ID" name="waPhoneNumberId"
            defaultValue={shop.waPhoneNumberId ?? ""}
            help="Found in the Meta app under WhatsApp → API Setup" />

          <Text label="WhatsApp Business Account ID" name="waWabaId"
            defaultValue={shop.waWabaId ?? ""}
            help="This keeps the template list and their status visible here" />

          <Secret label="Permanent access token" name="waToken" masked={shop.waToken}
            help="From a system user in Meta Business settings. Do not share it with anyone." />

          <Secret label="17TRACK API key" name="trackApiKey" masked={shop.trackApiKey}
            help="Out for delivery and Delivered come from this. 100 trackings free a month." />

          <Text label="Abandoned cart discount code" name="abandonCode"
            defaultValue={shop.abandonCode ?? ""}
            placeholder="e.g. WELCOME10"
            help="The second reminder (24 hours) goes out with this code. If it is empty the second reminder is not sent at all — better than sending a fake code." />

          <div style={S.field}>
            <label style={S.label} htmlFor="otpChannel">How the one-time code is sent</label>
            <select style={S.input} id="otpChannel" name="otpChannel" defaultValue={shop.otpChannel ?? "sms"}>
              <option value="sms">SMS first, WhatsApp if the SMS cannot be sent — recommended</option>
              <option value="both">WhatsApp first, SMS if that fails</option>
              <option value="whatsapp">WhatsApp only — about ₹0.14 a code</option>
            </select>
            <p style={S.help}>
              A code by SMS reaches every phone, including the ones without WhatsApp, and
              lands in the same app the shopper is typing into. Until an SMS provider is set up
              below, every choice here still falls back to WhatsApp.
            </p>
          </div>

          <Check label="Turn on SMS" name="smsEnabled" defaultChecked={shop.smsEnabled}
            help="Needs a Fast2SMS API key below. Their OTP route needs no DLT registration." />

          <Secret label="Fast2SMS API key" name="smsApiKey" masked={shop.smsApiKey}
            help="Fast2SMS dashboard → Dev API." />

          <div style={S.field}>
            <label style={S.label} htmlFor="smsRoute">SMS route</label>
            <select style={S.input} id="smsRoute" name="smsRoute" defaultValue={shop.smsRoute ?? "otp"}>
              <option value="otp">OTP route — cheap, does not reach DND numbers</option>
              <option value="q">Quick SMS — reaches DND too, around ₹5 a message</option>
            </select>
          </div>

          <Text label="SMS sender ID" name="smsSenderId"
            defaultValue={shop.smsSenderId ?? ""}
            placeholder="only used on the Quick SMS route"
            help="The OTP route uses Fast2SMS's own sender ID, so this can stay empty there." />

          <Text label="OTP template name" name="otpTemplate"
            defaultValue={shop.otpTemplate ?? ""}
            placeholder="zakdor_otp"
            help="The Meta template in the Authentication category that carries the one-time code. Leave it empty and the app looks for zakdor_otp." />

          <Check label="Turn on message sending" name="waEnabled" defaultChecked={shop.waEnabled}
            help="If this is off, everything stays in the queue and nothing is sent" />

          <hr style={{ border: 0, borderTop: "1px solid #e3e3e3", margin: "18px 0" }} />
          <h2 style={S.h2}>Which messages to send</h2>

          <Check label="Order placed" name="onOrderCreate" defaultChecked={shop.onOrderCreate}
            help="Only for a Cash-on-Delivery order when the confirmation ask below is off. A prepaid order gets Payment received instead, never both." />
          <Check label="Payment received (prepaid only)" name="onOrderPaid" defaultChecked={shop.onOrderPaid} />

          <div style={{ margin: "6px 0 12px", padding: "12px 14px", background: "#f7f7f7", borderRadius: 10 }}>
            <Check label="Cash on Delivery confirmation" name="codConfirm" defaultChecked={shop.codConfirm}
              help="The whole conversation: the ask, a reminder, and the confirmation. This prevents the most RTO." />
            <div style={{ paddingLeft: 24 }}>
              <Check label="The ask, right after the order" name="onCodConfirm" defaultChecked={shop.onCodConfirm} />
              <Check label="One reminder if there is no reply" name="onCodReminder" defaultChecked={shop.onCodReminder} />
              <Text label="Hours to wait before the reminder" name="codReminderHours" type="number"
                defaultValue={String(shop.codReminderHours)} help="Between 1 and 48." />
              <Check label="Confirmation message once the order is confirmed" name="onCodConfirmed" defaultChecked={shop.onCodConfirmed} />
              <Check label="Treat silence as yes" name="autoConfirm" defaultChecked={shop.autoConfirm}
                help="Still no reply after the reminder: the order is confirmed and packed. It is tagged cod-auto-confirmed in Shopify so you can tell those apart. Nothing is ever cancelled for silence." />
              <Text label="Minutes after the reminder before that happens" name="autoConfirmMin" type="number"
                defaultValue={String(shop.autoConfirmMin)} help="Between 5 and 1440. The cron runs every 10 minutes, so add up to 10 minutes to this." />
            </div>
          </div>
          <Check label="Shipped + tracking" name="onFulfilled" defaultChecked={shop.onFulfilled} />
          <Check label="In transit" name="onInTransit" defaultChecked={shop.onInTransit}
            help="Goes out once per order, the first time the courier scans it in transit - not on every hub. Worth turning on only for long routes, where it reassures. On a three-day delivery it lands right after the shipped message and reads as a repeat." />
          <Check label="Out for delivery" name="onOutForDelivery" defaultChecked={shop.onOutForDelivery}
            help="This will not arrive without 17TRACK — Shopify does not send this status" />
          <Check label="Delivered" name="onDelivered" defaultChecked={shop.onDelivered}
            help="This also comes from 17TRACK" />
          <Check label="Cancelled" name="onCancelled" defaultChecked={shop.onCancelled} />
          <Check label="Abandoned cart" name="onAbandoned" defaultChecked={shop.onAbandoned}
            help="Marketing category — ₹0.92 per message, seven times Utility" />

          <hr style={{ border: 0, borderTop: "1px solid #e3e3e3", margin: "18px 0" }} />
          <h2 style={S.h2}>Your own order form</h2>

          <Check label="Turn the order form on" name="formEnabled" defaultChecked={shop.formEnabled}
            help="The page at /apps/track/buy. It writes real orders, so leave it off until you have placed a test order yourself." />

          <Text label="Discount code for paying online, two items or more" name="prepaidCode"
            defaultValue={shop.prepaidCode ?? ""}
            placeholder="PREPAID35"
            help="Paying online saves ₹30 on a single item (code PREPAID30, built in) and ₹20 on each item when there are more - this code must take exactly ₹20 off every item in Shopify. The order form, the popup and the Pay Now message all promise these figures." />

          <h3 style={{ ...S.h2, fontSize: 15, marginTop: 18 }}>Razorpay, for paying inside the popup</h3>
          <p style={{ ...S.help, marginBottom: 12 }}>
            With both keys in, Pay online opens Razorpay right inside the popup and ends on the app's own
            "order confirmed" screen - no Shopify checkout, no email asked for. Leave them empty and Pay online
            goes to Shopify's checkout as before. Razorpay Dashboard → Account &amp; Settings → API Keys.
          </p>
          <Text label="Razorpay key ID" name="rzpKeyId"
            defaultValue={shop.rzpKeyId ?? ""}
            placeholder="rzp_live_XXXXXXXXXXXXXX"
            help="Starts with rzp_live_ (or rzp_test_ for a trial run with test cards)." />
          <Secret label="Razorpay key secret" name="rzpKeySecret" masked={shop.rzpKeySecret}
            help="Shown once by Razorpay when the key is made. Never leaves this server." />

          <hr style={{ border: 0, borderTop: "1px solid #e3e3e3", margin: "18px 0" }} />
          <h2 style={S.h2}>Your own WhatsApp</h2>

          <Text label="Your mobile number" name="ownerPhone"
            defaultValue={shop.ownerPhone ? String(shop.ownerPhone).replace(/^91(\d{10})$/, "$1") : ""}
            placeholder="9876543210"
            help="Whatever a customer writes back - a new address, a complaint, a message the app could not read - is forwarded here, with what the app replied. Needs the owner_alert template approved in Meta." />
          <Check label="Forward customer replies to that number" name="ownerAlerts" defaultChecked={shop.ownerAlerts}
            help="Confirm and Cancel taps are handled by the app and not forwarded; everything a customer types is." />

          <hr style={{ border: 0, borderTop: "1px solid #e3e3e3", margin: "18px 0" }} />
          <h2 style={S.h2}>When a customer cancels on WhatsApp</h2>

          <Check label="Cancel the order automatically" name="autoCancel"
            defaultChecked={shop.autoCancel}
            help="Nothing is cancelled the moment the button is pressed. The request waits for the time below, and if the customer presses Confirm in the meantime it is dropped and the order stands — a cancelled Shopify order can never be brought back." />

          <Text label="Wait before cancelling (minutes)" name="cancelGraceMin"
            type="number"
            defaultValue={String(shop.cancelGraceMin)}
            help="Between 5 and 720. Prepaid orders and anything already handed to the courier are never cancelled here — those are tagged for you to decide." />

          <button type="submit" style={S.btn}>Save</button>

          <p style={{ ...S.help, marginTop: 12 }}>
            Currently stored: phone number ID{" "}
            <b>{shop.waPhoneNumberId ?? "not set"}</b>, WABA ID{" "}
            <b>{shop.waWabaId ?? "not set"}</b>, token{" "}
            <b>{shop.waToken || "not set"}</b>, 17TRACK key{" "}
            <b>{shop.trackApiKey || "not set"}</b>, sending{" "}
            <b>{shop.waEnabled ? "on" : "off"}</b>, Razorpay in the popup{" "}
            <b>{shop.rzpKeyId && shop.rzpKeySecret ? "on" : "off"}</b>.
          </p>
        </Form>
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Test message</h2>
        <p style={{ ...S.help, marginBottom: 14 }}>
          Send one to your own number to check the whole path works. It only
          goes to numbers added to the recipient list in Meta.
        </p>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="test" />
          <div style={S.field}>
            <label style={S.label} htmlFor="testTemplate">Template</label>
            <input style={S.input} id="testTemplate" name="testTemplate"
              defaultValue="hello_world" autoComplete="off" />
            <p style={S.help}>
              Only an APPROVED template can be sent. <code style={S.code}>hello_world</code>{" "}
              is Meta's own sample and is approved from the start, so it proves the
              whole path works while your own templates are still pending.
            </p>
          </div>
          <div style={S.field}>
            <label style={S.label} htmlFor="testTo">Number</label>
            <input style={S.input} id="testTo" name="testTo" value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="9876543210" autoComplete="off" />
            <p style={S.help}>+91 is added automatically</p>
          </div>
          <button type="submit" style={S.btn} disabled={fetcher.state !== "idle"}>
            {fetcher.state !== "idle" ? "Sending..." : "Send"}
          </button>
        </fetcher.Form>
      </div>

      {templateList.length > 0 && (
        <div style={S.card}>
          <h2 style={S.h2}>WhatsApp templates in your account</h2>
          <p style={{ ...S.help, marginBottom: 14 }}>
            A template is stored under its name <i>and</i> its language. The app
            reads the language from this list before sending, so a template filed
            as en_US works without any change here.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Language</th>
                  <th style={S.th}>Variables</th>
                  <th style={S.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {templateList.map((t: any) => (
                  <tr key={`${t.name}-${t.language}`}>
                    <td style={S.td}><code style={S.code}>{t.name}</code></td>
                    <td style={S.td}>{t.language}</td>
                    <td style={S.td}>
                      {t.sends === null ? (
                        <span style={{ color: "#616161" }}>not used</span>
                      ) : t.sends === t.needs ? (
                        <span style={{ color: "#0b5c2e" }}>{t.needs} — matches</span>
                      ) : t.sendsOld === t.needs ? (
                        <span style={{ color: "#7a5a00" }}>
                          {t.needs} — matches the older wording; edit it in Meta when you can
                        </span>
                      ) : t.sends > t.needs ? (
                        <span style={{ color: "#7a5a00" }}>
                          needs {t.needs}, app holds {t.sends} — extra ones are dropped
                        </span>
                      ) : (
                        <span style={{ color: "#8e1c22" }}>
                          needs {t.needs}, app holds only {t.sends} — will not send
                        </span>
                      )}
                    </td>
                    <td style={S.td}>
                      <span style={{ color: t.status === "APPROVED" ? "#0b5c2e" : "#7a5a00" }}>
                        {t.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={S.card}>
        <h2 style={S.h2}>Courier tracking</h2>
        <p style={{ ...S.help, marginBottom: 14 }}>
          Out for delivery, Delivered, failed delivery and RTO — Shopify never
          sends these four. They come from 17TRACK. Two things must be set up:
        </p>
        <ol style={{ margin: "0 0 16px", paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>
          <li>
            17TRACK dashboard → Webhook URL:{" "}
            <code style={S.code}>{appUrl}/api/track-webhook</code>
          </li>
          <li>
            A cron every 15 minutes:{" "}
            <code style={S.code}>{appUrl}/api/cron?key=&lt;CRON_SECRET&gt;</code>
            {!cronSet && (
              <span style={{ color: "#8e1c22" }}> — CRON_SECRET is not in .env yet</span>
            )}
          </li>
        </ol>

        {parcels.length === 0 ? (
          <p style={S.help}>No parcel has shipped yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={S.th}>Order</th>
                  <th style={S.th}>Courier</th>
                  <th style={S.th}>Tracking</th>
                  <th style={S.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {parcels.map((p: any) => (
                  <tr key={p.id}>
                    <td style={S.td}>{p.order?.orderNumber ?? "-"}</td>
                    <td style={S.td}>{p.carrier ?? "-"}</td>
                    <td style={S.td}>
                      {p.trackingNo ?? "-"}
                      {p.trackingNo && !p.registered && (
                        <div style={{ fontSize: 11, color: "#b98900" }}>registration pending</div>
                      )}
                    </td>
                    <td style={S.td}>
                      {p.status}
                      {p.lastEventDesc && (
                        <div style={{ fontSize: 11, color: "#616161", marginTop: 3 }}>
                          {p.lastEventDesc}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {awaitingCancel.length > 0 && (
        <div style={{ ...S.card, borderColor: "#e0b4b4" }}>
          <h2 style={{ ...S.h2, color: "#8e1c22" }}>Waiting to be cancelled</h2>
          <p style={{ ...S.help, marginBottom: 14 }}>
            These customers pressed Cancel. Nothing has been cancelled yet — if
            they press Confirm before the wait is over, the order simply stands.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={S.th}>Order</th>
                  <th style={S.th}>Asked at</th>
                  <th style={S.th}>Payment</th>
                </tr>
              </thead>
              <tbody>
                {awaitingCancel.map((o: any) => (
                  <tr key={o.id}>
                    <td style={S.td}>
                      <a href={`https://${domain}/admin/orders/${o.shopifyId}`}
                        target="_blank" rel="noreferrer">{o.orderNumber}</a>
                    </td>
                    <td style={S.td}>
                      {new Date(o.cancelRequestedAt).toLocaleString("en-IN", {
                        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td style={S.td}>
                      {o.isCod ? "COD" : "Prepaid — tagged only, not cancelled"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={S.card}>
        <h2 style={S.h2}>Customer replies</h2>
        <p style={{ ...S.help, marginBottom: 14 }}>
          Everything customers send back, with the app's own answer under each.
          A tap on Confirm, Cancel, Change address, Change phone number or Help is
          acted on; anything else gets a short apology and a menu. Replies only
          arrive once the Callback URL is set in Meta:{" "}
          <code style={S.code}>{appUrl}/webhooks/whatsapp</code>, with the{" "}
          <code style={S.code}>messages</code> field subscribed.
        </p>
        {replies.length === 0 ? (
          <p style={S.help}>No reply has come in yet.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={S.th}>When</th>
                  <th style={S.th}>From</th>
                  <th style={S.th}>Message</th>
                  <th style={S.th}>Order</th>
                  <th style={S.th}>Read as</th>
                </tr>
              </thead>
              <tbody>
                {replies.map((r: any) => (
                  <tr key={r.id}>
                    <td style={S.td}>
                      {new Date(r.createdAt).toLocaleString("en-IN", {
                        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td style={S.td}>{r.from}</td>
                    <td style={S.td}>
                      {r.text}
                      {r.reply && (
                        <div style={{ fontSize: 12, color: "#616161", marginTop: 4 }}>↳ {r.reply}</div>
                      )}
                      {r.forwarded && (
                        <div style={{ fontSize: 11, color: "#0b5c2e", marginTop: 2 }}>forwarded to your WhatsApp</div>
                      )}
                    </td>
                    <td style={S.td}>{r.order?.orderNumber ?? "-"}</td>
                    <td style={S.td}>
                      <span style={{
                        color: r.intent === "confirm" ? "#0b5c2e"
                          : r.intent === "cancel" ? "#8e1c22"
                          : r.intent === "stop" ? "#7a5a00"
                          : "#616161",
                      }}>
                        {r.intent}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={S.card}>
        <h2 style={S.h2}>Recent messages</h2>
        {messages.length === 0 ? (
          <p style={S.help}>
            Nothing yet.{" "}
            <a href={`https://${domain}/admin/orders`} target="_blank" rel="noreferrer">
              Create an order
            </a>{" "}
            and come back here.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={S.th}>When</th>
                  <th style={S.th}>Event</th>
                  <th style={S.th}>To</th>
                  <th style={S.th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m: any) => (
                  <tr key={m.id}>
                    <td style={S.td}>
                      {new Date(m.createdAt).toLocaleString("en-IN", {
                        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td style={S.td}>{m.event}</td>
                    <td style={S.td}>{m.to}</td>
                    <td style={S.td}>
                      <Pill status={m.status} />
                      {m.status === "failed" && m.error && (
                        <div style={{ color: "#8e1c22", fontSize: 12, marginTop: 4 }}>
                          {m.error}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
