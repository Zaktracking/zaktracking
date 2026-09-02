/**
 * One-time codes over WhatsApp.
 *
 * The point of this is narrow: prove that the phone number typed into the
 * order form belongs to the person typing it. A fake number is where an RTO
 * begins, and it costs nothing to stop one here - a code costs about the
 * same as any other WhatsApp message.
 *
 * Two rules this file never bends:
 *   - the code itself is never stored, only a hash of it
 *   - a wrong code is counted, and after a few tries that code is dead
 */

import { createHash, randomInt } from "node:crypto";
import db from "../db.server";
import { sendSmsOtp } from "./sms.server";
import { mcConfigured, mcSend, mcVerify } from "./mc.server";

const GRAPH = "https://graph.facebook.com/v21.0";

/** How long a code stays usable. Meta's own template says ten minutes. */
const TTL_MINUTES = 10;
/** Wrong guesses allowed before the code is burned. */
const MAX_ATTEMPTS = 5;
/** New codes allowed for one number inside the window below. */
const MAX_SENDS = 3;
const SEND_WINDOW_MINUTES = 15;
/** Default template name; the merchant can change it on the admin page. */
const DEFAULT_TEMPLATE = "zakdor_otp";

/** Meta accepts lowercase letters, digits and underscores, nothing else. */
function safeName(raw: string | null | undefined): string {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hash(shopId: string, phone: string, code: string): string {
  // The shop id and phone are mixed in so the same six digits hash
  // differently for a different number - one leaked hash tells you nothing.
  return createHash("sha256").update(`${shopId}|${phone}|${code}`).digest("hex");
}

export type OtpResult =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSec?: number; detail?: string };

/* ------------------------------------------------------------------ */
/*  Sending                                                            */
/* ------------------------------------------------------------------ */

/**
 * An authentication template is not sent like the others. The code has to
 * appear twice - once in the body, and once in the copy-code button - or
 * Meta refuses the message. That is why this does not go through
 * sendTemplate.
 */
async function sendCode(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  template: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.to,
    type: "template",
    template: {
      name: opts.template,
      language: { code: "en" },
      components: [
        { type: "body", parameters: [{ type: "text", text: opts.code }] },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: opts.code }],
        },
      ],
    },
  };

  try {
    const res = await fetch(`${GRAPH}/${opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && json?.messages?.[0]?.id) return { ok: true };

    const err = json?.error ?? {};
    return {
      ok: false,
      error: `[${err.code ?? res.status}] ${err.message ?? "send failed"}`,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Creates a code, stores its hash, and sends it. */
export async function requestOtp(shopId: string, phone: string): Promise<OtpResult> {
  const shop = await db.shop.findUnique({ where: { id: shopId } });
  if (!shop) return { ok: false, reason: "Shop not found" };
  const anyChannel =
    (shop.waEnabled && shop.waToken && shop.waPhoneNumberId) ||
    (shop.smsEnabled && shop.smsApiKey) ||
    mcConfigured();
  if (!anyChannel) {
    return { ok: false, reason: "No way to send the code is set up yet" };
  }

  // Someone hammering the button is either impatient or hostile. Either way
  // the answer is the same, and it keeps the message bill sane.
  const since = new Date(Date.now() - SEND_WINDOW_MINUTES * 60 * 1000);
  const recent = await db.otpCode.count({
    where: { shopId, phone, sentAt: { gte: since } },
  });
  if (recent >= MAX_SENDS) {
    return {
      ok: false,
      reason: "Too many codes requested. Please try again in a few minutes.",
      retryAfterSec: SEND_WINDOW_MINUTES * 60,
    };
  }

  // randomInt is the cryptographic one. Math.random is guessable, and a
  // guessable code is no check at all.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

  // Which way the code travels.
  //
  //   whatsapp - about 14 paise, but only if the number is on WhatsApp
  //   sms      - always arrives, costs more
  //   both     - WhatsApp first, SMS only if that fails. This is the one
  //              worth having: the cheap route carries almost everyone, and
  //              nobody is left without a code.
  const channel = (shop.otpChannel || "whatsapp").toLowerCase();
  const canWa = Boolean(shop.waEnabled && shop.waToken && shop.waPhoneNumberId);
  const canSms = Boolean((shop.smsEnabled && shop.smsApiKey) || mcConfigured());

  let delivered = false;
  let lastError = "";
  let usedChannel = "";
  /** Message Central's verificationId, when the SMS went through them. */
  let smsRef: string | null = null;

  /** So a failure is visible on the app's own page, not only in the logs. */
  async function note(ch: string, status: string, error: string | null) {
    try {
      await db.messageLog.create({
        data: {
          shopId,
          channel: ch,
          event: "otp",
          to: phone,
          body: "One-time code",
          status,
          error,
          sentAt: status === "sent" ? new Date() : null,
        },
      });
    } catch (e: any) {
      console.log(`[otp] could not write the log line: ${e?.message ?? e}`);
    }
  }

  async function tryWhatsApp() {
    if (!canWa) return false;
    const r = await sendCode({
      phoneNumberId: shop!.waPhoneNumberId!,
      token: shop!.waToken!,
      to: phone,
      template: safeName(shop!.otpTemplate) || DEFAULT_TEMPLATE,
      code,
    });
    if (r.ok) { usedChannel = "whatsapp"; return true; }
    lastError = r.error ?? "WhatsApp send failed";
    console.log(`[otp] whatsapp failed for ${phone}: ${lastError}`);
    await note("whatsapp", "failed", lastError);
    return false;
  }

  async function trySms() {
    if (!canSms) return false;

    // Message Central first when it is set up: it needs no DLT, and it
    // makes its own code, so nothing of ours travels with the message.
    if (mcConfigured()) {
      const m = await mcSend(phone);
      if (m.ok) { usedChannel = "sms"; smsRef = m.ref; return true; }
      lastError = m.error;
      console.log(`[otp] sms failed for ${phone}: ${lastError}`);
      await note("sms", "failed", lastError);
      if (!(shop!.smsEnabled && shop!.smsApiKey)) return false;
    }
    const r = await sendSmsOtp({
      apiKey: shop!.smsApiKey!,
      phone,
      code,
      route: shop!.smsRoute,
      senderId: shop!.smsSenderId,
    });
    if (r.ok) { usedChannel = "sms"; return true; }
    lastError = r.error;
    console.log(`[otp] sms failed for ${phone}: ${lastError}`);
    await note("sms", "failed", lastError);
    return false;
  }

  // A code that never arrives is a lost order. So whichever way is put
  // first, the other one is always tried after it - the setting decides the
  // order, not whether the second one exists.
  if (channel === "sms") {
    delivered = (await trySms()) || (await tryWhatsApp());
  } else {
    delivered = (await tryWhatsApp()) || (await trySms());
  }

  if (!delivered) {
    return {
      ok: false,
      reason: "Could not send the code right now. Please try again in a minute.",
      // The provider's own words. Without this a merchant is left guessing
      // at a failure only the provider can explain.
      detail: lastError || "no channel accepted the message",
    };
  }

  await note(usedChannel || channel, "sent", null);

  // Any earlier code for this number is now void - otherwise two codes
  // would be live at once and the older one could still be used.
  await db.otpCode.updateMany({
    where: { shopId, phone, verifiedAt: null },
    data: { expiresAt: new Date(0) },
  });

  await db.otpCode.create({
    data: {
      shopId,
      phone,
      codeHash: hash(shopId, phone, code),
      provider: smsRef ? "mc" : "self",
      ref: smsRef,
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
    },
  });

  console.log(`[otp] code sent to ${phone} (${usedChannel || channel})`);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Checking                                                           */
/* ------------------------------------------------------------------ */

export async function verifyOtp(
  shopId: string,
  phone: string,
  code: string,
): Promise<OtpResult> {
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return { ok: false, reason: "Enter the 6-digit code" };

  const row = await db.otpCode.findFirst({
    where: { shopId, phone, verifiedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { sentAt: "desc" },
  });

  if (!row) return { ok: false, reason: "That code has expired. Ask for a new one." };

  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "Too many wrong tries. Ask for a new code." };
  }

  // A code Message Central made is one we never saw, so they are the only
  // ones who can say whether it matches.
  if (row.provider === "mc" && row.ref) {
    const v = await mcVerify(row.ref, clean);
    if (!v.ok) {
      await db.otpCode.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      const left = MAX_ATTEMPTS - (row.attempts + 1);
      return {
        ok: false,
        reason: left > 0 ? `Wrong code. ${left} tries left.` : "Too many wrong tries. Ask for a new code.",
      };
    }
    await db.otpCode.update({
      where: { id: row.id },
      data: { verifiedAt: new Date(), attempts: { increment: 1 } },
    });
    console.log(`[otp] ${phone} verified (sms)`);
    return { ok: true };
  }

  if (row.codeHash !== hash(shopId, phone, clean)) {
    await db.otpCode.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return {
      ok: false,
      reason: left > 0 ? `Wrong code. ${left} tries left.` : "Too many wrong tries. Ask for a new code.",
    };
  }

  await db.otpCode.update({
    where: { id: row.id },
    data: { verifiedAt: new Date(), attempts: { increment: 1 } },
  });

  console.log(`[otp] ${phone} verified`);
  return { ok: true };
}

/**
 * Whether this number cleared a code recently. The order form asks this
 * before it is allowed to create anything.
 */
export async function isVerified(
  shopId: string,
  phone: string,
  withinMinutes = 30,
): Promise<boolean> {
  const since = new Date(Date.now() - withinMinutes * 60 * 1000);
  const row = await db.otpCode.findFirst({
    where: { shopId, phone, verifiedAt: { gte: since } },
  });
  return Boolean(row);
}
