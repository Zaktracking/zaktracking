/* Zakdor - keep the provider's words away from the customer.

   When a code fails to send, the shopper was being shown whatever the SMS
   or WhatsApp provider said - "complete website verification", "DLT SMS
   API", "KYC". None of that is the customer's problem and none of it means
   anything to them. They get one plain line now.

   Nothing is lost: the provider's exact words still go to the server log
   and to the app's own Recent messages list, which is where they belong.

   One file changes. The old one is copied to ..\zak-bak first. */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const bak = path.join(root, '..', 'zak-bak')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = 'app/lib/otp.server.ts'

const full = path.join(root, target)
if (!fs.existsSync(full)) {
  console.error('ABORT - ' + target + ' not found. Run this from the repo root.')
  process.exit(1)
}

let src = fs.readFileSync(full, 'utf8')

const edits = [
  [
`  if (!delivered) {
    return {
      ok: false,
      reason: "Could not send the code right now. Please try again in a minute.",
      // The provider's own words. Without this a merchant is left guessing
      // at a failure only the provider can explain.
      detail: lastError || "no channel accepted the message",
    };
  }`,
`  if (!delivered) {
    // The provider's own words go to the log and to the app's Recent
    // messages, never to the shopper. "Complete website verification" or
    // "DLT SMS API" is a message for the merchant; to a customer standing
    // at a checkout it is noise that makes the store look broken.
    console.log(\`[otp] nothing sent to \${phone}: \${lastError || "no channel accepted the message"}\`);
    return {
      ok: false,
      reason: "Could not send the code right now. Please try again in a minute.",
    };
  }`,
  ],
  [
`  | { ok: false; reason: string; retryAfterSec?: number; detail?: string };`,
`  | { ok: false; reason: string; retryAfterSec?: number };`,
  ],
]

for (const [find, repl] of edits) {
  const n = src.split(find).length - 1
  if (n !== 1) {
    console.error(`ABORT - landmark found ${n} times:`)
    console.error('  ' + find.split('\n')[0].trim())
    process.exit(1)
  }
  src = src.replace(find, repl)
}

fs.mkdirSync(bak, { recursive: true })
fs.copyFileSync(full, path.join(bak, target.replace(/[\\/]/g, '_') + '.' + stamp + '.bak'))
fs.writeFileSync(full, src)

console.log('written  ' + target)
console.log('backup   ..\\zak-bak')
console.log('')
console.log('Next, one command at a time:')
console.log('  npm run build')
console.log('  git add -A')
console.log('  git commit -m "keep the provider\'s own words out of the customer\'s way"')
console.log('  git push')
