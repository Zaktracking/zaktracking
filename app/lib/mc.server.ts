/**
 * SMS one-time codes through Message Central (VerifyNow).
 *
 * Why this and not the old route: sending an OTP SMS in India normally
 * needs DLT - an entity registration, an approved sender ID and every
 * template cleared, which costs about six thousand rupees and takes days.
 * Message Central carries that registration itself, so nothing here waits
 * on paperwork.
 *
 * One thing works differently to every other sender in this codebase:
 * Message Central makes the code itself and keeps it. We never see it.
 * So the SMS path cannot store a hash the way the WhatsApp path does -
 * it stores their verificationId instead, and asks them to check the
 * code when the customer types it in. otp.server.ts handles both shapes.
 *
 * Switched on purely by the two environment variables below. If they are
 * missing, nothing here ever runs and the old route is left alone.
 */

const BASE = "https://cpaas.messagecentral.com";

/** Their token is a JWT and lasts hours, so it is kept rather than
 *  re-fetched on every message. Cleared on any 401. */
let cached: { token: string; until: number } | null = null;

export function mcConfigured(): boolean {
  return Boolean(process.env.MC_CUSTOMER_ID && process.env.MC_KEY);
}

/** Message Central wants a bare ten-digit number, country code separate. */
export function toTen(phone: string): string | null {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 12 && d.startsWith("91")) return d.slice(2);
  if (d.length === 13 && d.startsWith("091")) return d.slice(3);
  return null;
}

async function token(): Promise<string | null> {
  if (cached && cached.until > Date.now()) return cached.token;

  const q = new URLSearchParams({
    customerId: String(process.env.MC_CUSTOMER_ID || ""),
    key: String(process.env.MC_KEY || ""),
    scope: "NEW",
    country: "91",
  });
  if (process.env.MC_EMAIL) q.set("email", String(process.env.MC_EMAIL));

  try {
    const res = await fetch(`${BASE}/auth/v1/authentication/token?${q.toString()}`, {
      headers: { accept: "*/*" },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.token) {
      cached = { token: String(j.token), until: Date.now() + 6 * 60 * 60 * 1000 };
      return cached.token;
    }
    console.log(`[mc] login failed: ${j?.message ?? "HTTP " + res.status}`);
    return null;
  } catch (e: any) {
    console.log(`[mc] login error: ${e?.message ?? e}`);
    return null;
  }
}

/** Sends the code. flowType SMS is what keeps this off WhatsApp - their
 *  API would otherwise be free to pick a channel of its own. */
export async function mcSend(
  phone: string,
): Promise<{ ok: true; ref: string } | { ok: false; error: string }> {
  const to = toTen(phone);
  if (!to) return { ok: false, error: "Not an Indian mobile number" };

  const t = await token();
  if (!t) return { ok: false, error: "Message Central login failed" };

  const q = new URLSearchParams({
    countryCode: "91",
    flowType: "SMS",
    mobileNumber: to,
    otpLength: "6",
  });

  try {
    const res = await fetch(`${BASE}/verification/v3/send?${q.toString()}`, {
      method: "POST",
      headers: { authToken: t },
    });
    const j: any = await res.json().catch(() => ({}));
    const ref = j?.data?.verificationId;
    if (res.ok && ref) return { ok: true, ref: String(ref) };
    if (res.status === 401) cached = null;
    return { ok: false, error: String(j?.message ?? `HTTP ${res.status}`) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Asks them whether the typed code matches the one they sent. */
export async function mcVerify(
  ref: string,
  code: string,
): Promise<{ ok: boolean; error?: string }> {
  const t = await token();
  if (!t) return { ok: false, error: "Message Central login failed" };

  const q = new URLSearchParams({ verificationId: ref, code });

  try {
    const res = await fetch(`${BASE}/verification/v3/validateOtp?${q.toString()}`, {
      headers: { authToken: t },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.data?.verificationStatus === "VERIFICATION_COMPLETED") return { ok: true };
    if (res.status === 401) cached = null;
    return {
      ok: false,
      error: String(j?.data?.verificationStatus ?? j?.message ?? `HTTP ${res.status}`),
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
