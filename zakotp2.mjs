#!/usr/bin/env node
/* ZakTracking - one-time codes: SMS fallback + a visible failure line.
 *
 * One file changes: app/lib/otp.server.ts
 *   - whichever way is chosen first, the other one is now always tried too,
 *     so a code still arrives while WhatsApp is blocked
 *   - every send, and every failure with its real reason, is written to the
 *     message log so it shows on the app page instead of only in the server logs
 *
 * Nothing is written unless the file is exactly what this installer expects.
 * Run it twice and the second run does nothing.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const norm = (s) => s.replace(/\r\n/g, '\n');
const crlf = (s) => (s.match(/\r\n/g) || []).length > (s.split('\n').length / 2);

const FILES = [
  {
    "path": "app/lib/otp.server.ts",
    "fromShas": [
      "310168dcc18fb60adc18a91a217d6be603fbe7285a842b564a9cffeefdeed358",
      "389ea0b366a992ba76ac9afc9108a12cf71e33def0d26261d403e50d508ef74a"
    ],
    "toSha": "389ea0b366a992ba76ac9afc9108a12cf71e33def0d26261d403e50d508ef74a",
    "content": "/**\n * One-time codes over WhatsApp.\n *\n * The point of this is narrow: prove that the phone number typed into the\n * order form belongs to the person typing it. A fake number is where an RTO\n * begins, and it costs nothing to stop one here - a code costs about the\n * same as any other WhatsApp message.\n *\n * Two rules this file never bends:\n *   - the code itself is never stored, only a hash of it\n *   - a wrong code is counted, and after a few tries that code is dead\n */\n\nimport { createHash, randomInt } from \"node:crypto\";\nimport db from \"../db.server\";\nimport { sendSmsOtp } from \"./sms.server\";\n\nconst GRAPH = \"https://graph.facebook.com/v21.0\";\n\n/** How long a code stays usable. Meta's own template says ten minutes. */\nconst TTL_MINUTES = 10;\n/** Wrong guesses allowed before the code is burned. */\nconst MAX_ATTEMPTS = 5;\n/** New codes allowed for one number inside the window below. */\nconst MAX_SENDS = 3;\nconst SEND_WINDOW_MINUTES = 15;\n/** Default template name; the merchant can change it on the admin page. */\nconst DEFAULT_TEMPLATE = \"zakdor_otp\";\n\nfunction hash(shopId: string, phone: string, code: string): string {\n  // The shop id and phone are mixed in so the same six digits hash\n  // differently for a different number - one leaked hash tells you nothing.\n  return createHash(\"sha256\").update(`${shopId}|${phone}|${code}`).digest(\"hex\");\n}\n\nexport type OtpResult =\n  | { ok: true }\n  | { ok: false; reason: string; retryAfterSec?: number };\n\n/* ------------------------------------------------------------------ */\n/*  Sending                                                            */\n/* ------------------------------------------------------------------ */\n\n/**\n * An authentication template is not sent like the others. The code has to\n * appear twice - once in the body, and once in the copy-code button - or\n * Meta refuses the message. That is why this does not go through\n * sendTemplate.\n */\nasync function sendCode(opts: {\n  phoneNumberId: string;\n  token: string;\n  to: string;\n  template: string;\n  code: string;\n}): Promise<{ ok: boolean; error?: string }> {\n  const body = {\n    messaging_product: \"whatsapp\",\n    recipient_type: \"individual\",\n    to: opts.to,\n    type: \"template\",\n    template: {\n      name: opts.template,\n      language: { code: \"en\" },\n      components: [\n        { type: \"body\", parameters: [{ type: \"text\", text: opts.code }] },\n        {\n          type: \"button\",\n          sub_type: \"url\",\n          index: \"0\",\n          parameters: [{ type: \"text\", text: opts.code }],\n        },\n      ],\n    },\n  };\n\n  try {\n    const res = await fetch(`${GRAPH}/${opts.phoneNumberId}/messages`, {\n      method: \"POST\",\n      headers: {\n        Authorization: `Bearer ${opts.token}`,\n        \"Content-Type\": \"application/json\",\n      },\n      body: JSON.stringify(body),\n    });\n    const json: any = await res.json().catch(() => ({}));\n    if (res.ok && json?.messages?.[0]?.id) return { ok: true };\n\n    const err = json?.error ?? {};\n    return {\n      ok: false,\n      error: `[${err.code ?? res.status}] ${err.message ?? \"send failed\"}`,\n    };\n  } catch (e: any) {\n    return { ok: false, error: String(e?.message ?? e) };\n  }\n}\n\n/** Creates a code, stores its hash, and sends it. */\nexport async function requestOtp(shopId: string, phone: string): Promise<OtpResult> {\n  const shop = await db.shop.findUnique({ where: { id: shopId } });\n  if (!shop) return { ok: false, reason: \"Shop not found\" };\n  const anyChannel =\n    (shop.waEnabled && shop.waToken && shop.waPhoneNumberId) ||\n    (shop.smsEnabled && shop.smsApiKey);\n  if (!anyChannel) {\n    return { ok: false, reason: \"No way to send the code is set up yet\" };\n  }\n\n  // Someone hammering the button is either impatient or hostile. Either way\n  // the answer is the same, and it keeps the message bill sane.\n  const since = new Date(Date.now() - SEND_WINDOW_MINUTES * 60 * 1000);\n  const recent = await db.otpCode.count({\n    where: { shopId, phone, sentAt: { gte: since } },\n  });\n  if (recent >= MAX_SENDS) {\n    return {\n      ok: false,\n      reason: \"Too many codes requested. Please try again in a few minutes.\",\n      retryAfterSec: SEND_WINDOW_MINUTES * 60,\n    };\n  }\n\n  // randomInt is the cryptographic one. Math.random is guessable, and a\n  // guessable code is no check at all.\n  const code = String(randomInt(0, 1_000_000)).padStart(6, \"0\");\n\n  // Which way the code travels.\n  //\n  //   whatsapp - about 14 paise, but only if the number is on WhatsApp\n  //   sms      - always arrives, costs more\n  //   both     - WhatsApp first, SMS only if that fails. This is the one\n  //              worth having: the cheap route carries almost everyone, and\n  //              nobody is left without a code.\n  const channel = (shop.otpChannel || \"whatsapp\").toLowerCase();\n  const canWa = Boolean(shop.waEnabled && shop.waToken && shop.waPhoneNumberId);\n  const canSms = Boolean(shop.smsEnabled && shop.smsApiKey);\n\n  let delivered = false;\n  let lastError = \"\";\n  let usedChannel = \"\";\n\n  /** So a failure is visible on the app's own page, not only in the logs. */\n  async function note(ch: string, status: string, error: string | null) {\n    try {\n      await db.messageLog.create({\n        data: {\n          shopId,\n          channel: ch,\n          event: \"otp\",\n          to: phone,\n          body: \"One-time code\",\n          status,\n          error,\n          sentAt: status === \"sent\" ? new Date() : null,\n        },\n      });\n    } catch (e: any) {\n      console.log(`[otp] could not write the log line: ${e?.message ?? e}`);\n    }\n  }\n\n  async function tryWhatsApp() {\n    if (!canWa) return false;\n    const r = await sendCode({\n      phoneNumberId: shop!.waPhoneNumberId!,\n      token: shop!.waToken!,\n      to: phone,\n      template: shop!.otpTemplate || DEFAULT_TEMPLATE,\n      code,\n    });\n    if (r.ok) { usedChannel = \"whatsapp\"; return true; }\n    lastError = r.error ?? \"WhatsApp send failed\";\n    console.log(`[otp] whatsapp failed for ${phone}: ${lastError}`);\n    await note(\"whatsapp\", \"failed\", lastError);\n    return false;\n  }\n\n  async function trySms() {\n    if (!canSms) return false;\n    const r = await sendSmsOtp({\n      apiKey: shop!.smsApiKey!,\n      phone,\n      code,\n      route: shop!.smsRoute,\n      senderId: shop!.smsSenderId,\n    });\n    if (r.ok) { usedChannel = \"sms\"; return true; }\n    lastError = r.error;\n    console.log(`[otp] sms failed for ${phone}: ${lastError}`);\n    await note(\"sms\", \"failed\", lastError);\n    return false;\n  }\n\n  // A code that never arrives is a lost order. So whichever way is put\n  // first, the other one is always tried after it - the setting decides the\n  // order, not whether the second one exists.\n  if (channel === \"sms\") {\n    delivered = (await trySms()) || (await tryWhatsApp());\n  } else {\n    delivered = (await tryWhatsApp()) || (await trySms());\n  }\n\n  if (!delivered) {\n    return {\n      ok: false,\n      reason: \"Could not send the code right now. Please try again in a minute.\",\n    };\n  }\n\n  await note(usedChannel || channel, \"sent\", null);\n\n  // Any earlier code for this number is now void - otherwise two codes\n  // would be live at once and the older one could still be used.\n  await db.otpCode.updateMany({\n    where: { shopId, phone, verifiedAt: null },\n    data: { expiresAt: new Date(0) },\n  });\n\n  await db.otpCode.create({\n    data: {\n      shopId,\n      phone,\n      codeHash: hash(shopId, phone, code),\n      expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),\n    },\n  });\n\n  console.log(`[otp] code sent to ${phone} (${usedChannel || channel})`);\n  return { ok: true };\n}\n\n/* ------------------------------------------------------------------ */\n/*  Checking                                                           */\n/* ------------------------------------------------------------------ */\n\nexport async function verifyOtp(\n  shopId: string,\n  phone: string,\n  code: string,\n): Promise<OtpResult> {\n  const clean = String(code || \"\").replace(/\\D/g, \"\");\n  if (clean.length !== 6) return { ok: false, reason: \"Enter the 6-digit code\" };\n\n  const row = await db.otpCode.findFirst({\n    where: { shopId, phone, verifiedAt: null, expiresAt: { gt: new Date() } },\n    orderBy: { sentAt: \"desc\" },\n  });\n\n  if (!row) return { ok: false, reason: \"That code has expired. Ask for a new one.\" };\n\n  if (row.attempts >= MAX_ATTEMPTS) {\n    return { ok: false, reason: \"Too many wrong tries. Ask for a new code.\" };\n  }\n\n  if (row.codeHash !== hash(shopId, phone, clean)) {\n    await db.otpCode.update({\n      where: { id: row.id },\n      data: { attempts: { increment: 1 } },\n    });\n    const left = MAX_ATTEMPTS - (row.attempts + 1);\n    return {\n      ok: false,\n      reason: left > 0 ? `Wrong code. ${left} tries left.` : \"Too many wrong tries. Ask for a new code.\",\n    };\n  }\n\n  await db.otpCode.update({\n    where: { id: row.id },\n    data: { verifiedAt: new Date(), attempts: { increment: 1 } },\n  });\n\n  console.log(`[otp] ${phone} verified`);\n  return { ok: true };\n}\n\n/**\n * Whether this number cleared a code recently. The order form asks this\n * before it is allowed to create anything.\n */\nexport async function isVerified(\n  shopId: string,\n  phone: string,\n  withinMinutes = 30,\n): Promise<boolean> {\n  const since = new Date(Date.now() - withinMinutes * 60 * 1000);\n  const row = await db.otpCode.findFirst({\n    where: { shopId, phone, verifiedAt: { gte: since } },\n  });\n  return Boolean(row);\n}\n"
  }
]


let todo = [];
let skipped = 0;
let bad = [];

for (const f of FILES) {
  if (!existsSync(f.path)) { bad.push(`${f.path}: not found`); continue; }
  const now = readFileSync(f.path, 'utf8');
  const got = sha(now);
  if (got === f.toSha) { skipped++; continue; }
  if (f.fromShas.includes(got)) { todo.push({ f, crlf: false }); continue; }
  if (f.fromShas.includes(sha(norm(now)))) { todo.push({ f, crlf: crlf(now) }); continue; }
  bad.push(`${f.path}: this file is not what I expected (${got.slice(0, 12)})`);
}

if (bad.length) {
  console.log('Nothing was written. Fix these first:');
  for (const b of bad) console.log('  - ' + b);
  process.exit(1);
}

for (const t of todo) {
  const out = t.crlf ? t.f.content.replace(/\n/g, '\r\n') : t.f.content;
  writeFileSync(t.f.path, out, 'utf8');
  const back = readFileSync(t.f.path, 'utf8');
  if (sha(norm(back)) !== sha(norm(t.f.content))) {
    console.log('Write did not land: ' + t.f.path);
    process.exit(1);
  }
  console.log('updated  ' + t.f.path);
}

console.log(`done - ${todo.length} updated, ${skipped} already up to date`);
