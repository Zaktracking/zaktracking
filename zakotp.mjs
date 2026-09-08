/*
 * zakotp.mjs
 *
 * The code in the customer's hand was being refused.
 *
 * What happened, from the logs of the failing attempt:
 *
 *   10:45:38.875  code sent to 9196086...  (sms, through Message Central)
 *   10:45:39.074  sms failed: REQUEST_ALREADY_EXISTS
 *   10:45:40.096  code sent to 9196086...  (whatsapp)
 *
 * Two identical requests arrived a second apart - the button pressed
 * twice, or the browser sending the same thing again; both carried the
 * same proxy signature. The first put a code in an SMS. The second asked
 * Message Central for another, and they answered "a request already
 * exists" - which is not a failure, it means their code is still live.
 * The app read it as a failure, fell through to WhatsApp, minted a
 * different code, and - because a new code voids the old - threw away the
 * one the customer was reading off their screen.
 *
 * So the SMS arrived, the customer typed it, and the app compared it with
 * a WhatsApp code they had never seen. "Wrong code."
 *
 * This could only happen once Message Central was switched on, because
 * Message Central makes the code itself and never shows it to us - the two
 * channels cannot carry the same digits. Two fixes, both small:
 *
 *   - A code sent in the last 45 seconds is still the good one. A second
 *     press sends nothing and says nothing new. One tap, one code -
 *     whatever the channel, and one message less to pay for.
 *
 *   - REQUEST_ALREADY_EXISTS is read for what it means. Their code is out
 *     there, so nothing else is sent down any channel and the row for it
 *     is left exactly as it is, still checkable.
 *
 * A real failure - Message Central down, a bad key - still falls through
 * to WhatsApp as before.
 *
 * Every file it touches is copied to ..\zak-bak first, and a file that is
 * not the version this script was built against is left alone and named.
 * Run it from the repo root, after zakrefund.mjs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

const FILES = [
 {
  "path": "app/lib/mc.server.ts",
  "was": "98c1797410729d0721d8ab223fdf30c6",
  "body": "/**\n * SMS one-time codes through Message Central (VerifyNow).\n *\n * Why this and not the old route: sending an OTP SMS in India normally\n * needs DLT - an entity registration, an approved sender ID and every\n * template cleared, which costs about six thousand rupees and takes days.\n * Message Central carries that registration itself, so nothing here waits\n * on paperwork.\n *\n * One thing works differently to every other sender in this codebase:\n * Message Central makes the code itself and keeps it. We never see it.\n * So the SMS path cannot store a hash the way the WhatsApp path does -\n * it stores their verificationId instead, and asks them to check the\n * code when the customer types it in. otp.server.ts handles both shapes.\n *\n * Switched on purely by the two environment variables below. If they are\n * missing, nothing here ever runs and the old route is left alone.\n */\n\nconst BASE = \"https://cpaas.messagecentral.com\";\n\n/** Their token is a JWT and lasts hours, so it is kept rather than\n *  re-fetched on every message. Cleared on any 401. */\nlet cached: { token: string; until: number } | null = null;\n\nexport function mcConfigured(): boolean {\n  return Boolean(process.env.MC_CUSTOMER_ID && process.env.MC_KEY);\n}\n\n/** Message Central wants a bare ten-digit number, country code separate. */\nexport function toTen(phone: string): string | null {\n  const d = String(phone || \"\").replace(/\\D/g, \"\");\n  if (d.length === 10) return d;\n  if (d.length === 12 && d.startsWith(\"91\")) return d.slice(2);\n  if (d.length === 13 && d.startsWith(\"091\")) return d.slice(3);\n  return null;\n}\n\nasync function token(): Promise<string | null> {\n  if (cached && cached.until > Date.now()) return cached.token;\n\n  const q = new URLSearchParams({\n    customerId: String(process.env.MC_CUSTOMER_ID || \"\"),\n    key: String(process.env.MC_KEY || \"\"),\n    scope: \"NEW\",\n    country: \"91\",\n  });\n  if (process.env.MC_EMAIL) q.set(\"email\", String(process.env.MC_EMAIL));\n\n  try {\n    const res = await fetch(`${BASE}/auth/v1/authentication/token?${q.toString()}`, {\n      headers: { accept: \"*/*\" },\n    });\n    const j: any = await res.json().catch(() => ({}));\n    if (j?.token) {\n      cached = { token: String(j.token), until: Date.now() + 6 * 60 * 60 * 1000 };\n      return cached.token;\n    }\n    console.log(`[mc] login failed: ${j?.message ?? \"HTTP \" + res.status}`);\n    return null;\n  } catch (e: any) {\n    console.log(`[mc] login error: ${e?.message ?? e}`);\n    return null;\n  }\n}\n\n/** Sends the code. flowType SMS is what keeps this off WhatsApp - their\n *  API would otherwise be free to pick a channel of its own. */\nexport async function mcSend(\n  phone: string,\n): Promise<{ ok: true; ref: string } | { ok: false; already?: boolean; error: string }> {\n  const to = toTen(phone);\n  if (!to) return { ok: false, error: \"Not an Indian mobile number\" };\n\n  const t = await token();\n  if (!t) return { ok: false, error: \"Message Central login failed\" };\n\n  const q = new URLSearchParams({\n    countryCode: \"91\",\n    flowType: \"SMS\",\n    mobileNumber: to,\n    otpLength: \"6\",\n  });\n\n  try {\n    const res = await fetch(`${BASE}/verification/v3/send?${q.toString()}`, {\n      method: \"POST\",\n      headers: { authToken: t },\n    });\n    const j: any = await res.json().catch(() => ({}));\n    const ref = j?.data?.verificationId;\n    if (res.ok && ref) return { ok: true, ref: String(ref) };\n    if (res.status === 401) cached = null;\n\n    const why = String(j?.message ?? j?.data?.errorMessage ?? `HTTP ${res.status}`);\n    // REQUEST_ALREADY_EXISTS is not a failure. It means they still hold a\n    // live code for this number - the customer has it in their hand. The\n    // caller must not send a different one down another channel: Message\n    // Central makes the code and never shows it to us, so the SMS the\n    // customer can actually see would then be the one we refuse.\n    if (/ALREADY_EXISTS/i.test(why)) return { ok: false, already: true, error: why };\n    return { ok: false, error: why };\n  } catch (e: any) {\n    return { ok: false, error: String(e?.message ?? e) };\n  }\n}\n\n/** Asks them whether the typed code matches the one they sent. */\nexport async function mcVerify(\n  ref: string,\n  code: string,\n): Promise<{ ok: boolean; error?: string }> {\n  const t = await token();\n  if (!t) return { ok: false, error: \"Message Central login failed\" };\n\n  const q = new URLSearchParams({ verificationId: ref, code });\n\n  try {\n    const res = await fetch(`${BASE}/verification/v3/validateOtp?${q.toString()}`, {\n      headers: { authToken: t },\n    });\n    const j: any = await res.json().catch(() => ({}));\n    if (j?.data?.verificationStatus === \"VERIFICATION_COMPLETED\") return { ok: true };\n    if (res.status === 401) cached = null;\n    return {\n      ok: false,\n      error: String(j?.data?.verificationStatus ?? j?.message ?? `HTTP ${res.status}`),\n    };\n  } catch (e: any) {\n    return { ok: false, error: String(e?.message ?? e) };\n  }\n}\n"
 },
 {
  "path": "app/lib/otp.server.ts",
  "was": "d440e787289fd3d90ccbddcaa61c1639",
  "body": "/**\n * One-time codes over WhatsApp.\n *\n * The point of this is narrow: prove that the phone number typed into the\n * order form belongs to the person typing it. A fake number is where an RTO\n * begins, and it costs nothing to stop one here - a code costs about the\n * same as any other WhatsApp message.\n *\n * Two rules this file never bends:\n *   - the code itself is never stored, only a hash of it\n *   - a wrong code is counted, and after a few tries that code is dead\n */\n\nimport { createHash, randomInt } from \"node:crypto\";\nimport db from \"../db.server\";\nimport { sendSmsOtp } from \"./sms.server\";\nimport { mcConfigured, mcSend, mcVerify } from \"./mc.server\";\n\nconst GRAPH = \"https://graph.facebook.com/v21.0\";\n\n/** How long a code stays usable. Meta's own template says ten minutes. */\nconst TTL_MINUTES = 10;\n/** Wrong guesses allowed before the code is burned. */\nconst MAX_ATTEMPTS = 5;\n/** New codes allowed for one number inside the window below. */\nconst MAX_SENDS = 3;\nconst SEND_WINDOW_MINUTES = 15;\n/** Default template name; the merchant can change it on the admin page. */\nconst DEFAULT_TEMPLATE = \"zakdor_otp\";\n\n/** Meta accepts lowercase letters, digits and underscores, nothing else. */\nfunction safeName(raw: string | null | undefined): string {\n  return String(raw || \"\")\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9_]+/g, \"_\")\n    .replace(/^_+|_+$/g, \"\");\n}\n\nfunction hash(shopId: string, phone: string, code: string): string {\n  // The shop id and phone are mixed in so the same six digits hash\n  // differently for a different number - one leaked hash tells you nothing.\n  return createHash(\"sha256\").update(`${shopId}|${phone}|${code}`).digest(\"hex\");\n}\n\nexport type OtpResult =\n  | { ok: true }\n  | { ok: false; reason: string; retryAfterSec?: number };\n\n/* ------------------------------------------------------------------ */\n/*  Sending                                                            */\n/* ------------------------------------------------------------------ */\n\n/**\n * An authentication template is not sent like the others. The code has to\n * appear twice - once in the body, and once in the copy-code button - or\n * Meta refuses the message. That is why this does not go through\n * sendTemplate.\n */\nasync function sendCode(opts: {\n  phoneNumberId: string;\n  token: string;\n  to: string;\n  template: string;\n  code: string;\n}): Promise<{ ok: boolean; error?: string }> {\n  const body = {\n    messaging_product: \"whatsapp\",\n    recipient_type: \"individual\",\n    to: opts.to,\n    type: \"template\",\n    template: {\n      name: opts.template,\n      language: { code: \"en\" },\n      components: [\n        { type: \"body\", parameters: [{ type: \"text\", text: opts.code }] },\n        {\n          type: \"button\",\n          sub_type: \"url\",\n          index: \"0\",\n          parameters: [{ type: \"text\", text: opts.code }],\n        },\n      ],\n    },\n  };\n\n  try {\n    const res = await fetch(`${GRAPH}/${opts.phoneNumberId}/messages`, {\n      method: \"POST\",\n      headers: {\n        Authorization: `Bearer ${opts.token}`,\n        \"Content-Type\": \"application/json\",\n      },\n      body: JSON.stringify(body),\n    });\n    const json: any = await res.json().catch(() => ({}));\n    if (res.ok && json?.messages?.[0]?.id) return { ok: true };\n\n    const err = json?.error ?? {};\n    return {\n      ok: false,\n      error: `[${err.code ?? res.status}] ${err.message ?? \"send failed\"}`,\n    };\n  } catch (e: any) {\n    return { ok: false, error: String(e?.message ?? e) };\n  }\n}\n\n/** Creates a code, stores its hash, and sends it. */\nexport async function requestOtp(shopId: string, phone: string): Promise<OtpResult> {\n  const shop = await db.shop.findUnique({ where: { id: shopId } });\n  if (!shop) return { ok: false, reason: \"Shop not found\" };\n  const anyChannel =\n    (shop.waEnabled && shop.waToken && shop.waPhoneNumberId) ||\n    (shop.smsEnabled && shop.smsApiKey) ||\n    mcConfigured();\n  if (!anyChannel) {\n    return { ok: false, reason: \"No way to send the code is set up yet\" };\n  }\n\n  // Someone hammering the button is either impatient or hostile. Either way\n  // the answer is the same, and it keeps the message bill sane.\n  const since = new Date(Date.now() - SEND_WINDOW_MINUTES * 60 * 1000);\n  const recent = await db.otpCode.count({\n    where: { shopId, phone, sentAt: { gte: since } },\n  });\n  if (recent >= MAX_SENDS) {\n    return {\n      ok: false,\n      reason: \"Too many codes requested. Please try again in a few minutes.\",\n      retryAfterSec: SEND_WINDOW_MINUTES * 60,\n    };\n  }\n\n  // One tap, one code.\n  //\n  // The button can be pressed twice, and a browser will sometimes send the\n  // same request again by itself. Each of those used to mint a fresh code\n  // and kill the one before it - so the customer read the first code off\n  // their screen and the app had already thrown it away. Worse with\n  // Message Central in front: their second answer is \"a request already\n  // exists\", we fell through to WhatsApp, and the two channels then held\n  // two different codes. A code sent seconds ago is still the good one.\n  const live = await db.otpCode.findFirst({\n    where: { shopId, phone, verifiedAt: null, expiresAt: { gt: new Date() } },\n    orderBy: { sentAt: \"desc\" },\n  });\n  if (live && Date.now() - new Date(live.sentAt).getTime() < 45_000) {\n    console.log(`[otp] ${phone} was sent a code seconds ago - that one still stands`);\n    return { ok: true };\n  }\n\n  // randomInt is the cryptographic one. Math.random is guessable, and a\n  // guessable code is no check at all.\n  const code = String(randomInt(0, 1_000_000)).padStart(6, \"0\");\n\n  // Which way the code travels.\n  //\n  //   whatsapp - about 14 paise, but only if the number is on WhatsApp\n  //   sms      - always arrives, costs more\n  //   both     - WhatsApp first, SMS only if that fails. This is the one\n  //              worth having: the cheap route carries almost everyone, and\n  //              nobody is left without a code.\n  // Left unset, SMS goes first: it reaches every phone and lands in the\n  // app the shopper is already typing in. With no SMS provider configured\n  // trySms() answers false at once and WhatsApp carries the code as before.\n  const channel = (shop.otpChannel || \"sms\").toLowerCase();\n  const canWa = Boolean(shop.waEnabled && shop.waToken && shop.waPhoneNumberId);\n  const canSms = Boolean((shop.smsEnabled && shop.smsApiKey) || mcConfigured());\n\n  let delivered = false;\n  let lastError = \"\";\n  let usedChannel = \"\";\n  /** Message Central still holds a live code for this number. */\n  let stillLive = false;\n  /** Message Central's verificationId, when the SMS went through them. */\n  let smsRef: string | null = null;\n\n  /** So a failure is visible on the app's own page, not only in the logs. */\n  async function note(ch: string, status: string, error: string | null) {\n    try {\n      await db.messageLog.create({\n        data: {\n          shopId,\n          channel: ch,\n          event: \"otp\",\n          to: phone,\n          body: \"One-time code\",\n          status,\n          error,\n          sentAt: status === \"sent\" ? new Date() : null,\n        },\n      });\n    } catch (e: any) {\n      console.log(`[otp] could not write the log line: ${e?.message ?? e}`);\n    }\n  }\n\n  async function tryWhatsApp() {\n    if (!canWa) return false;\n    const r = await sendCode({\n      phoneNumberId: shop!.waPhoneNumberId!,\n      token: shop!.waToken!,\n      to: phone,\n      template: safeName(shop!.otpTemplate) || DEFAULT_TEMPLATE,\n      code,\n    });\n    if (r.ok) { usedChannel = \"whatsapp\"; return true; }\n    lastError = r.error ?? \"WhatsApp send failed\";\n    console.log(`[otp] whatsapp failed for ${phone}: ${lastError}`);\n    await note(\"whatsapp\", \"failed\", lastError);\n    return false;\n  }\n\n  async function trySms() {\n    if (!canSms) return false;\n\n    // Message Central first when it is set up: it needs no DLT, and it\n    // makes its own code, so nothing of ours travels with the message.\n    if (mcConfigured()) {\n      const m = await mcSend(phone);\n      if (m.ok) { usedChannel = \"sms\"; smsRef = m.ref; return true; }\n      // Their code is already out there. Nothing more is sent - not by SMS,\n      // not by WhatsApp - or the customer would end up holding two codes\n      // and reading the wrong one.\n      if (m.already) { stillLive = true; return true; }\n      lastError = m.error;\n      console.log(`[otp] sms failed for ${phone}: ${lastError}`);\n      await note(\"sms\", \"failed\", lastError);\n      if (!(shop!.smsEnabled && shop!.smsApiKey)) return false;\n    }\n    const r = await sendSmsOtp({\n      apiKey: shop!.smsApiKey!,\n      phone,\n      code,\n      route: shop!.smsRoute,\n      senderId: shop!.smsSenderId,\n    });\n    if (r.ok) { usedChannel = \"sms\"; return true; }\n    lastError = r.error;\n    console.log(`[otp] sms failed for ${phone}: ${lastError}`);\n    await note(\"sms\", \"failed\", lastError);\n    return false;\n  }\n\n  // A code that never arrives is a lost order. So whichever way is put\n  // first, the other one is always tried after it - the setting decides the\n  // order, not whether the second one exists.\n  if (channel === \"sms\") {\n    delivered = (await trySms()) || (await tryWhatsApp());\n  } else {\n    delivered = (await tryWhatsApp()) || (await trySms());\n  }\n\n  if (!delivered) {\n    // The provider's own words go to the log and to the app's Recent\n    // messages, never to the shopper. \"Complete website verification\" or\n    // \"DLT SMS API\" is a message for the merchant; to a customer standing\n    // at a checkout it is noise that makes the store look broken.\n    console.log(`[otp] nothing sent to ${phone}: ${lastError || \"no channel accepted the message\"}`);\n    return {\n      ok: false,\n      reason: \"Could not send the code right now. Please try again in a minute.\",\n    };\n  }\n\n  // Nothing new went out, so nothing is written down: the row for the code\n  // the customer is holding stays exactly as it is, still checkable.\n  if (stillLive) {\n    console.log(`[otp] ${phone}: the code already sent is still live - none sent`);\n    return { ok: true };\n  }\n\n  await note(usedChannel || channel, \"sent\", null);\n\n  // Any earlier code for this number is now void - otherwise two codes\n  // would be live at once and the older one could still be used.\n  await db.otpCode.updateMany({\n    where: { shopId, phone, verifiedAt: null },\n    data: { expiresAt: new Date(0) },\n  });\n\n  await db.otpCode.create({\n    data: {\n      shopId,\n      phone,\n      codeHash: hash(shopId, phone, code),\n      provider: smsRef ? \"mc\" : \"self\",\n      ref: smsRef,\n      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),\n    },\n  });\n\n  console.log(`[otp] code sent to ${phone} (${usedChannel || channel})`);\n  return { ok: true };\n}\n\n/* ------------------------------------------------------------------ */\n/*  Checking                                                           */\n/* ------------------------------------------------------------------ */\n\nexport async function verifyOtp(\n  shopId: string,\n  phone: string,\n  code: string,\n): Promise<OtpResult> {\n  const clean = String(code || \"\").replace(/\\D/g, \"\");\n  if (clean.length !== 6) return { ok: false, reason: \"Enter the 6-digit code\" };\n\n  const row = await db.otpCode.findFirst({\n    where: { shopId, phone, verifiedAt: null, expiresAt: { gt: new Date() } },\n    orderBy: { sentAt: \"desc\" },\n  });\n\n  if (!row) return { ok: false, reason: \"That code has expired. Ask for a new one.\" };\n\n  if (row.attempts >= MAX_ATTEMPTS) {\n    return { ok: false, reason: \"Too many wrong tries. Ask for a new code.\" };\n  }\n\n  // A code Message Central made is one we never saw, so they are the only\n  // ones who can say whether it matches.\n  if (row.provider === \"mc\" && row.ref) {\n    const v = await mcVerify(row.ref, clean);\n    if (!v.ok) {\n      await db.otpCode.update({\n        where: { id: row.id },\n        data: { attempts: { increment: 1 } },\n      });\n      const left = MAX_ATTEMPTS - (row.attempts + 1);\n      return {\n        ok: false,\n        reason: left > 0 ? `Wrong code. ${left} tries left.` : \"Too many wrong tries. Ask for a new code.\",\n      };\n    }\n    await db.otpCode.update({\n      where: { id: row.id },\n      data: { verifiedAt: new Date(), attempts: { increment: 1 } },\n    });\n    console.log(`[otp] ${phone} verified (sms)`);\n    return { ok: true };\n  }\n\n  if (row.codeHash !== hash(shopId, phone, clean)) {\n    await db.otpCode.update({\n      where: { id: row.id },\n      data: { attempts: { increment: 1 } },\n    });\n    const left = MAX_ATTEMPTS - (row.attempts + 1);\n    return {\n      ok: false,\n      reason: left > 0 ? `Wrong code. ${left} tries left.` : \"Too many wrong tries. Ask for a new code.\",\n    };\n  }\n\n  await db.otpCode.update({\n    where: { id: row.id },\n    data: { verifiedAt: new Date(), attempts: { increment: 1 } },\n  });\n\n  console.log(`[otp] ${phone} verified`);\n  return { ok: true };\n}\n\n/**\n * Whether this number cleared a code recently. The order form asks this\n * before it is allowed to create anything.\n */\nexport async function isVerified(\n  shopId: string,\n  phone: string,\n  withinMinutes = 30,\n): Promise<boolean> {\n  const since = new Date(Date.now() - withinMinutes * 60 * 1000);\n  const row = await db.otpCode.findFirst({\n    where: { shopId, phone, verifiedAt: { gte: since } },\n  });\n  return Boolean(row);\n}\n"
 }
];

const ROOT = process.cwd();
const written = [], skipped = [], replaced = [];
// Windows may have given a file CRLF line endings; the content is what counts.
const sum = (t) => createHash("md5").update(t.replace(/\r\n/g, "\n"), "utf8").digest("hex");

if (!existsSync(join(ROOT, "package.json")) || !existsSync(join(ROOT, "app", "lib"))) {
  console.log("Run this from the repo root - the folder with package.json and app\\lib in it.");
  process.exit(1);
}

for (const f of FILES) {
  const p = join(ROOT, f.path);
  const there = existsSync(p) ? readFileSync(p, "utf8") : null;

  if (there !== null && sum(there) === sum(f.body)) { console.log("  " + f.path + " already done"); continue; }

  const bak = join(ROOT, "..", "zak-bak", f.path);

  if (f.was === null) {
    if (there !== null) {
      mkdirSync(dirname(bak), { recursive: true });
      writeFileSync(bak + ".prev", there, "utf8");
      replaced.push(f.path);
    }
  } else {
    if (there === null) { skipped.push(f.path + " - missing"); continue; }
    const now = sum(there);

    if (now === f.was) {
      mkdirSync(dirname(bak), { recursive: true });
      copyFileSync(p, bak);
    } else if (existsSync(bak) && sum(readFileSync(bak, "utf8")) === f.was) {
      writeFileSync(bak + ".prev", there, "utf8");
      replaced.push(f.path);
    } else {
      skipped.push(f.path + " - changed since this script was built");
      continue;
    }
  }

  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.body, "utf8");
  written.push(f.path);
}

console.log("");
for (const f of written) console.log("written  " + f);
for (const f of replaced) console.log("         " + f + " was already written by an earlier run - old copy kept as zak-bak\\...\\.prev");
for (const s of skipped) console.log("SKIPPED  " + s);
if (!written.length && !skipped.length) console.log("  nothing to change");

if (skipped.length) {
  console.log("");
  console.log("Those were left alone. Tell Claude which ones, before you build.");
} else {
  console.log("backup   ..\\zak-bak");
  console.log("");
  console.log("Next, one command at a time:");
  console.log("  npm run build");
  console.log("  git add -A");
  console.log("  git commit -m \"one tap, one otp - the code the customer is holding is the one we check\"");
  console.log("  git push");
  console.log("");
}
console.log("");
