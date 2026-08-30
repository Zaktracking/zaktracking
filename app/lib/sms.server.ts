/**
 * SMS through Fast2SMS.
 *
 * Why this provider and not one of the big ones: sending SMS in India
 * normally needs DLT registration - an entity registration, a sender ID and
 * every message template approved, which wants a GST certificate, about
 * five thousand rupees and up to three weeks. Fast2SMS has two routes that
 * skip all of it, and OTP is exactly what they are meant for.
 *
 * Two routes, and the difference matters:
 *
 *   otp  - the service route. Cheap. Uses their own pre-approved template,
 *          so the message reads "<code> is your verification code" and we
 *          only supply the code. Does not reach numbers on DND.
 *   q    - Quick SMS. Around five rupees a message, which is thirty-five
 *          times WhatsApp, but it reaches DND numbers too.
 *
 * The default is the cheap one. Nothing here ever runs unless the merchant
 * has pasted a key in.
 */

const BASE = "https://www.fast2sms.com/dev/bulkV2";

export type SmsResult = { ok: true } | { ok: false; error: string };

/** Fast2SMS wants a bare ten-digit number, no country code. */
export function toIndianTen(phone: string): string | null {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 13 && d.startsWith("091")) return d.slice(3);
  return null;
}

/**
 * Sends the one-time code.
 *
 * The code is the only thing that travels on the cheap route - their
 * template supplies the words around it.
 */
export async function sendSmsOtp(opts: {
  apiKey: string;
  phone: string;
  code: string;
  /** "otp" (cheap, no DND) or "q" (Quick SMS, reaches DND, ~Rs 5) */
  route?: string | null;
  /** only used on the q route, where we write the whole message */
  senderId?: string | null;
}): Promise<SmsResult> {
  const to = toIndianTen(opts.phone);
  if (!to) return { ok: false, error: "Not an Indian mobile number" };

  const route = (opts.route || "otp").toLowerCase() === "q" ? "q" : "otp";

  const params = new URLSearchParams({ route, numbers: to });

  if (route === "otp") {
    params.set("variables_values", opts.code);
  } else {
    params.set(
      "message",
      `${opts.code} is your verification code. Do not share it with anyone.`,
    );
    params.set("flash", "0");
    if (opts.senderId) params.set("sender_id", opts.senderId);
  }

  try {
    const res = await fetch(`${BASE}?${params.toString()}`, {
      method: "GET",
      headers: { authorization: opts.apiKey, "cache-control": "no-cache" },
    });

    const json: any = await res.json().catch(() => ({}));

    // Fast2SMS answers { return: true, ... } when it accepted the message.
    if (res.ok && json?.return === true) return { ok: true };

    const msg =
      (Array.isArray(json?.message) ? json.message.join(" ") : json?.message) ||
      `HTTP ${res.status}`;
    return { ok: false, error: String(msg) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
