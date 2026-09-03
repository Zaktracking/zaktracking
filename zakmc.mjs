/* Zakdor - wires Message Central (VerifyNow) in as the SMS fallback.
   WhatsApp stays on Meta and stays branded ZAKDOR. Only the fallback,
   for numbers with no WhatsApp, moves to SMS.

   Nothing is deleted. Backups go OUTSIDE the repo, into ..\zak-bak.
   Every patch is checked for its landmark first; if any landmark is
   missing or appears twice, the whole thing aborts before writing. */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const bak  = path.join(root, '..', 'zak-bak')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

function read(p) { return fs.readFileSync(path.join(root, p), 'utf8') }
function exists(p) { return fs.existsSync(path.join(root, p)) }

const writes = []
function plan(p, body) { writes.push([p, body]) }

function patch(src, file, edits) {
  let out = src
  for (const [find, repl] of edits) {
    const n = out.split(find).length - 1
    if (n !== 1) {
      console.error(`ABORT - landmark found ${n} times in ${file}:`)
      console.error('  ' + find.split('\n')[0].trim())
      process.exit(1)
    }
    out = out.replace(find, repl)
  }
  return out
}

for (const f of ['app/lib/otp.server.ts', 'prisma/schema.prisma']) {
  if (!exists(f)) { console.error(`ABORT - ${f} not found. Run this from the repo root.`); process.exit(1) }
}

/* ---------------- 1. the new file ---------------- */

plan('app/lib/mc.server.ts', `/**
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
  const d = String(phone || "").replace(/\\D/g, "");
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
    const res = await fetch(\`\${BASE}/auth/v1/authentication/token?\${q.toString()}\`, {
      headers: { accept: "*/*" },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.token) {
      cached = { token: String(j.token), until: Date.now() + 6 * 60 * 60 * 1000 };
      return cached.token;
    }
    console.log(\`[mc] login failed: \${j?.message ?? "HTTP " + res.status}\`);
    return null;
  } catch (e: any) {
    console.log(\`[mc] login error: \${e?.message ?? e}\`);
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
    const res = await fetch(\`\${BASE}/verification/v3/send?\${q.toString()}\`, {
      method: "POST",
      headers: { authToken: t },
    });
    const j: any = await res.json().catch(() => ({}));
    const ref = j?.data?.verificationId;
    if (res.ok && ref) return { ok: true, ref: String(ref) };
    if (res.status === 401) cached = null;
    return { ok: false, error: String(j?.message ?? \`HTTP \${res.status}\`) };
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
    const res = await fetch(\`\${BASE}/verification/v3/validateOtp?\${q.toString()}\`, {
      headers: { authToken: t },
    });
    const j: any = await res.json().catch(() => ({}));
    if (j?.data?.verificationStatus === "VERIFICATION_COMPLETED") return { ok: true };
    if (res.status === 401) cached = null;
    return {
      ok: false,
      error: String(j?.data?.verificationStatus ?? j?.message ?? \`HTTP \${res.status}\`),
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
`)

/* ---------------- 2. schema ---------------- */

{
  const f = 'prisma/schema.prisma'
  const src = read(f)
  plan(f, patch(src, f, [[
`  phone    String
  codeHash String`,
`  phone    String
  codeHash String
  /// "self" when we made the code, "mc" when Message Central holds it.
  provider String @default("self")
  /// Message Central's verificationId. Null on every self-made code.
  ref      String?`
  ]]))
}

/* ---------------- 3. otp.server.ts ---------------- */

{
  const f = 'app/lib/otp.server.ts'
  const src = read(f)
  plan(f, patch(src, f, [
    [
`import { sendSmsOtp } from "./sms.server";`,
`import { sendSmsOtp } from "./sms.server";
import { mcConfigured, mcSend, mcVerify } from "./mc.server";`
    ],
    [
`    (shop.smsEnabled && shop.smsApiKey);`,
`    (shop.smsEnabled && shop.smsApiKey) ||
    mcConfigured();`
    ],
    [
`  const canSms = Boolean(shop.smsEnabled && shop.smsApiKey);`,
`  const canSms = Boolean((shop.smsEnabled && shop.smsApiKey) || mcConfigured());`
    ],
    [
`  let delivered = false;
  let lastError = "";
  let usedChannel = "";`,
`  let delivered = false;
  let lastError = "";
  let usedChannel = "";
  /** Message Central's verificationId, when the SMS went through them. */
  let smsRef: string | null = null;`
    ],
    [
`  async function trySms() {
    if (!canSms) return false;`,
`  async function trySms() {
    if (!canSms) return false;

    // Message Central first when it is set up: it needs no DLT, and it
    // makes its own code, so nothing of ours travels with the message.
    if (mcConfigured()) {
      const m = await mcSend(phone);
      if (m.ok) { usedChannel = "sms"; smsRef = m.ref; return true; }
      lastError = m.error;
      console.log(\`[otp] sms failed for \${phone}: \${lastError}\`);
      await note("sms", "failed", lastError);
      if (!(shop!.smsEnabled && shop!.smsApiKey)) return false;
    }`
    ],
    [
`      codeHash: hash(shopId, phone, code),
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),`,
`      codeHash: hash(shopId, phone, code),
      provider: smsRef ? "mc" : "self",
      ref: smsRef,
      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),`
    ],
    [
`  if (row.codeHash !== hash(shopId, phone, clean)) {`,
`  // A code Message Central made is one we never saw, so they are the only
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
        reason: left > 0 ? \`Wrong code. \${left} tries left.\` : "Too many wrong tries. Ask for a new code.",
      };
    }
    await db.otpCode.update({
      where: { id: row.id },
      data: { verifiedAt: new Date(), attempts: { increment: 1 } },
    });
    console.log(\`[otp] \${phone} verified (sms)\`);
    return { ok: true };
  }

  if (row.codeHash !== hash(shopId, phone, clean)) {`
    ],
  ]))
}

/* ---------------- write ---------------- */

fs.mkdirSync(bak, { recursive: true })
let n = 0
for (const [p, body] of writes) {
  const full = path.join(root, p)
  if (fs.existsSync(full)) {
    const dest = path.join(bak, p.replace(/[\\/]/g, '_') + '.' + stamp + '.bak')
    fs.copyFileSync(full, dest)
  }
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, body)
  console.log('written  ' + p)
  n++
}

console.log(`\nDone. ${n} file(s) written. Backups in ..\\zak-bak`)
console.log('\nNext, one command at a time:')
console.log('  npx prisma migrate dev --name mcotp')
console.log('  npm run build')
console.log('  git add -A')
console.log('  git commit -m "sms otp fallback through message central"')
console.log('  git push')
