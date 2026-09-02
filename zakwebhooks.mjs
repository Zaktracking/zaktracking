#!/usr/bin/env node
/* ZakTracking - the last three files still on the old renderMessage() way.
 *
 *   webhooks.orders.create.tsx     order received / ask for COD confirmation
 *   webhooks.orders.fulfilled.tsx  your order has shipped
 *   webhooks.orders.paid.tsx       payment received
 *
 * Same story as the cancelled webhook: they build their own message text and
 * call a function notify.server.ts no longer has. Replaced with the versions
 * that go through the template system, exactly like the rest.
 *
 * Backups go to ../zak-bak, OUTSIDE the repo. A .bak sitting inside app/ is
 * picked up by the router and breaks the build on its own - learned that the
 * hard way.
 *
 * Safe to run twice.
 */
import fs from "node:fs";
import path from "node:path";

const FILES = [
  {
    "path": "app/routes/webhooks.orders.create.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgeyBhdXRoZW50aWNhdGUgfSBmcm9tICIuLi9zaG9waWZ5LnNlcnZlciI7CmltcG9ydCB7IGZpcnN0RGVsaXZlcnksIGVuc3VyZVNob3AsIHVwc2VydE9yZGVyIH0gZnJvbSAiLi4vbGliL3dlYmhvb2suc2VydmVyIjsKaW1wb3J0IHsgcXVldWVNZXNzYWdlLCBldmVudEVuYWJsZWQgfSBmcm9tICIuLi9saWIvbm90aWZ5LnNlcnZlciI7CmltcG9ydCB7IGJsYW5rVmFycywgaXRlbUxpbmUsIG1vbmV5LCBldGFSYW5nZSwgb3JkZXJUb3RhbCB9IGZyb20gIi4uL2xpYi90ZW1wbGF0ZXMuc2VydmVyIjsKaW1wb3J0IHsgbWFya0NvbnZlcnRlZCB9IGZyb20gIi4uL2xpYi9hYmFuZG9uZWQuc2VydmVyIjsKCmV4cG9ydCBjb25zdCBhY3Rpb24gPSBhc3luYyAoeyByZXF1ZXN0IH06IEFjdGlvbkZ1bmN0aW9uQXJncykgPT4gewogIGNvbnN0IHsgc2hvcCwgdG9waWMsIHBheWxvYWQgfSA9IGF3YWl0IGF1dGhlbnRpY2F0ZS53ZWJob29rKHJlcXVlc3QpOwoKICBpZiAoIShhd2FpdCBmaXJzdERlbGl2ZXJ5KHJlcXVlc3QsIHRvcGljLCBzaG9wKSkpIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKCiAgY29uc3Qgb3JkZXIgPSBwYXlsb2FkIGFzIGFueTsKICBjb25zdCBzID0gYXdhaXQgZW5zdXJlU2hvcChzaG9wKTsKICBjb25zdCByZWMgPSBhd2FpdCB1cHNlcnRPcmRlcihzLmlkLCBvcmRlcik7CgogIC8vIFRoaXMgZmlyc3QuIFNlbmRpbmcgInlvdXIgY2FydCBpcyB3YWl0aW5nIiB0byBzb21lb25lIHdobyBoYXMganVzdAogIC8vIGJvdWdodCBpcyB0aGUgd29yc3QgcG9zc2libGUgZXhwZXJpZW5jZSAtIGFuZCBpdCBhbHNvIGNvc3RzIG1vbmV5IGF0CiAgLy8gdGhlIE1hcmtldGluZyByYXRlLgogIGF3YWl0IG1hcmtDb252ZXJ0ZWQocy5pZCwgW29yZGVyLmNhcnRfdG9rZW4sIG9yZGVyLmNoZWNrb3V0X3Rva2VuLCBvcmRlci5jaGVja291dF9pZF0pOwoKICBjb25zdCB2ID0gYmxhbmtWYXJzKCk7CiAgdi5uYW1lID0gcmVjLmN1c3RvbWVyTmFtZSB8fCAidGhlcmUiOwogIHYub3JkZXIgPSByZWMub3JkZXJOdW1iZXI7CiAgdi5pdGVtID0gaXRlbUxpbmUob3JkZXIpOwogIHYuYW1vdW50ID0gbW9uZXkob3JkZXJUb3RhbChvcmRlciksIG9yZGVyLmN1cnJlbmN5KTsKICB2LmV0YSA9IGV0YVJhbmdlKCk7CgogIC8vIEZvciBDT0Qgd2UgYXNrIGZvciBjb25maXJtYXRpb24sIGZvciBwcmVwYWlkIHdlIHNlbmQgIm9yZGVyIHJlY2VpdmVkIi4KICAvLyBHZXR0aW5nIENPRCBjb25maXJtZWQgY3V0cyBSVE8gKHRoZSBwYXJjZWwgY29taW5nIGJhY2spIHRoZSBtb3N0LgogIGNvbnN0IGV2ZW50ID0gcmVjLmlzQ29kICYmIHMuY29kQ29uZmlybSA/ICJjb2RfY29uZmlybSIgOiAib3JkZXJfY3JlYXRlZCI7CgogIGlmIChldmVudEVuYWJsZWQocywgZXZlbnQpKSB7CiAgICBhd2FpdCBxdWV1ZU1lc3NhZ2UoewogICAgICBzaG9wSWQ6IHMuaWQsCiAgICAgIG9yZGVySWQ6IHJlYy5pZCwKICAgICAgZXZlbnQsCiAgICAgIHRvOiByZWMucGhvbmUsCiAgICAgIHZhcnM6IHYsCiAgICB9KTsKICB9CgogIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKfTsK"
  },
  {
    "path": "app/routes/webhooks.orders.fulfilled.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgeyBhdXRoZW50aWNhdGUgfSBmcm9tICIuLi9zaG9waWZ5LnNlcnZlciI7CmltcG9ydCB7IGZpcnN0RGVsaXZlcnksIGVuc3VyZVNob3AsIHVwc2VydE9yZGVyIH0gZnJvbSAiLi4vbGliL3dlYmhvb2suc2VydmVyIjsKaW1wb3J0IHsgcXVldWVNZXNzYWdlLCBldmVudEVuYWJsZWQgfSBmcm9tICIuLi9saWIvbm90aWZ5LnNlcnZlciI7CmltcG9ydCB7IGJsYW5rVmFycywgaXRlbUxpbmUsIGV0YVJhbmdlIH0gZnJvbSAiLi4vbGliL3RlbXBsYXRlcy5zZXJ2ZXIiOwoKZXhwb3J0IGNvbnN0IGFjdGlvbiA9IGFzeW5jICh7IHJlcXVlc3QgfTogQWN0aW9uRnVuY3Rpb25BcmdzKSA9PiB7CiAgY29uc3QgeyBzaG9wLCB0b3BpYywgcGF5bG9hZCB9ID0gYXdhaXQgYXV0aGVudGljYXRlLndlYmhvb2socmVxdWVzdCk7CgogIGlmICghKGF3YWl0IGZpcnN0RGVsaXZlcnkocmVxdWVzdCwgdG9waWMsIHNob3ApKSkgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwoKICBjb25zdCBvcmRlciA9IHBheWxvYWQgYXMgYW55OwogIGNvbnN0IHMgPSBhd2FpdCBlbnN1cmVTaG9wKHNob3ApOwogIGNvbnN0IHJlYyA9IGF3YWl0IHVwc2VydE9yZGVyKHMuaWQsIG9yZGVyKTsKCiAgY29uc3QgZiA9IChvcmRlci5mdWxmaWxsbWVudHMgPz8gW10pLmZpbmQoCiAgICAoeDogYW55KSA9PiB4LnRyYWNraW5nX251bWJlciB8fCB4LnRyYWNraW5nX3VybCwKICApOwoKICBjb25zdCB2ID0gYmxhbmtWYXJzKCk7CiAgdi5uYW1lID0gcmVjLmN1c3RvbWVyTmFtZSB8fCAidGhlcmUiOwogIHYub3JkZXIgPSByZWMub3JkZXJOdW1iZXI7CiAgdi5pdGVtID0gaXRlbUxpbmUob3JkZXIpOwogIHYuY291cmllciA9IGY/LnRyYWNraW5nX2NvbXBhbnkgfHwgIm91ciBjb3VyaWVyIHBhcnRuZXIiOwogIHYudHJhY2tpbmcgPSBmPy50cmFja2luZ19udW1iZXIgfHwgIiI7CiAgdi5ldGEgPSBldGFSYW5nZSgpOwoKICBpZiAoIWV2ZW50RW5hYmxlZChzLCAic2hpcHBlZCIpKSByZXR1cm4gbmV3IFJlc3BvbnNlKCk7CgogIGF3YWl0IHF1ZXVlTWVzc2FnZSh7CiAgICBzaG9wSWQ6IHMuaWQsCiAgICBvcmRlcklkOiByZWMuaWQsCiAgICBldmVudDogInNoaXBwZWQiLAogICAgdG86IHJlYy5waG9uZSwKICAgIHZhcnM6IHYsCiAgfSk7CgogIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKfTsK"
  },
  {
    "path": "app/routes/webhooks.orders.paid.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgeyBhdXRoZW50aWNhdGUgfSBmcm9tICIuLi9zaG9waWZ5LnNlcnZlciI7CmltcG9ydCB7IGZpcnN0RGVsaXZlcnksIGVuc3VyZVNob3AsIHVwc2VydE9yZGVyIH0gZnJvbSAiLi4vbGliL3dlYmhvb2suc2VydmVyIjsKaW1wb3J0IHsgcXVldWVNZXNzYWdlLCBldmVudEVuYWJsZWQgfSBmcm9tICIuLi9saWIvbm90aWZ5LnNlcnZlciI7CmltcG9ydCB7IGJsYW5rVmFycywgaXRlbUxpbmUsIG1vbmV5LCBldGFSYW5nZSwgb3JkZXJUb3RhbCB9IGZyb20gIi4uL2xpYi90ZW1wbGF0ZXMuc2VydmVyIjsKCmV4cG9ydCBjb25zdCBhY3Rpb24gPSBhc3luYyAoeyByZXF1ZXN0IH06IEFjdGlvbkZ1bmN0aW9uQXJncykgPT4gewogIGNvbnN0IHsgc2hvcCwgdG9waWMsIHBheWxvYWQgfSA9IGF3YWl0IGF1dGhlbnRpY2F0ZS53ZWJob29rKHJlcXVlc3QpOwoKICBpZiAoIShhd2FpdCBmaXJzdERlbGl2ZXJ5KHJlcXVlc3QsIHRvcGljLCBzaG9wKSkpIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKCiAgY29uc3Qgb3JkZXIgPSBwYXlsb2FkIGFzIGFueTsKICBjb25zdCBzID0gYXdhaXQgZW5zdXJlU2hvcChzaG9wKTsKCiAgLy8gdXBzZXJ0LCBub3QgZmluZFVuaXF1ZTogb3JkZXJzL2NyZWF0ZSBhbmQgb3JkZXJzL3BhaWQgY2FuIGFycml2ZSBpbiB0aGUKICAvLyBzYW1lIHNlY29uZCwgYW5kIHNvbWV0aW1lcyBpbiB0aGUgcmV2ZXJzZSBvcmRlci4gV2hpY2hldmVyIGxhbmRzIGZpcnN0CiAgLy8gY3JlYXRlcyB0aGUgcm93IGFuZCBmaWxscyBpbiBpc0NvZCBjb3JyZWN0bHkuCiAgY29uc3QgcmVjID0gYXdhaXQgdXBzZXJ0T3JkZXIocy5pZCwgb3JkZXIpOwoKICAvLyBBIENPRCBvcmRlciBmaXJlcyBvcmRlcnMvcGFpZCB0b28gLSBidXQgV0VFS1MgTEFURVIsIHdoZW4gdGhlIGNvdXJpZXIKICAvLyBkZXBvc2l0cyB0aGUgY2FzaC4gU2VuZGluZyAiUGF5bWVudCByZWNlaXZlZCIgdGhlbiByZWFkcyBhcyBzcGFtOyB0aGUKICAvLyBwYXJjZWwgd2FzIGRlbGl2ZXJlZCBsb25nIGFnby4KICBpZiAocmVjLmlzQ29kKSB7CiAgICBjb25zb2xlLmxvZyhgW29yZGVycy9wYWlkXSAke3JlYy5vcmRlck51bWJlcn0gaXMgQ09ELCBubyBtZXNzYWdlIHNlbnRgKTsKICAgIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKICB9CgogIC8vIFNlY29uZCBndWFyZCwgZm9yIHRoZSBwYXJ0aWFsLXBheW1lbnQgY2FzZS4gU2hvcGlmeSBmaXJlcyBvcmRlcnMvcGFpZAogIC8vIHdoZW4gdGhlIHNtYWxsIGFkdmFuY2UgaXMgdGFrZW4sIHdoaWxlIHRoZSByZXN0IGlzIHN0aWxsIG93ZWQgYXQgdGhlCiAgLy8gZG9vci4gU2F5aW5nICJ3ZSBoYXZlIHJlY2VpdmVkIHlvdXIgcGF5bWVudCIgdGhlbiBpcyBzaW1wbHkgdW50cnVlLgogIGNvbnN0IHN0aWxsT3dlZCA9IE51bWJlcihvcmRlcj8udG90YWxfb3V0c3RhbmRpbmcgPz8gMCk7CiAgaWYgKE51bWJlci5pc0Zpbml0ZShzdGlsbE93ZWQpICYmIHN0aWxsT3dlZCA+IDApIHsKICAgIGNvbnNvbGUubG9nKAogICAgICBgW29yZGVycy9wYWlkXSAke3JlYy5vcmRlck51bWJlcn0gc3RpbGwgaGFzICR7c3RpbGxPd2VkfSBvdXRzdGFuZGluZywgbm8gbWVzc2FnZSBzZW50YCwKICAgICk7CiAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCk7CiAgfQoKICBpZiAoIWV2ZW50RW5hYmxlZChzLCAib3JkZXJfcGFpZCIpKSByZXR1cm4gbmV3IFJlc3BvbnNlKCk7CgogIGNvbnN0IHYgPSBibGFua1ZhcnMoKTsKICB2Lm5hbWUgPSByZWMuY3VzdG9tZXJOYW1lIHx8ICJ0aGVyZSI7CiAgdi5vcmRlciA9IHJlYy5vcmRlck51bWJlcjsKICB2Lml0ZW0gPSBpdGVtTGluZShvcmRlcik7CiAgdi5hbW91bnQgPSBtb25leShvcmRlclRvdGFsKG9yZGVyKSwgb3JkZXIuY3VycmVuY3kpOwogIHYuZXRhID0gZXRhUmFuZ2UoKTsKCiAgYXdhaXQgcXVldWVNZXNzYWdlKHsKICAgIHNob3BJZDogcy5pZCwKICAgIG9yZGVySWQ6IHJlYy5pZCwKICAgIGV2ZW50OiAib3JkZXJfcGFpZCIsCiAgICB0bzogcmVjLnBob25lLAogICAgdmFyczogdiwKICB9KTsKCiAgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwp9Owo="
  }
];
const BAK = path.resolve("..", "zak-bak");

let written = 0, already = 0;

for (const f of FILES) {
  const p = path.resolve(f.path);
  if (!fs.existsSync(p)) {
    console.error("MISSING  " + f.path + " - is this the zaktracking repo root?");
    process.exit(1);
  }
  const text = fs.readFileSync(p, "utf8");
  if (!text.includes("renderMessage")) { already++; continue; }

  fs.mkdirSync(BAK, { recursive: true });
  fs.writeFileSync(path.join(BAK, path.basename(f.path) + ".bak"), text);
  fs.writeFileSync(p, Buffer.from(f.b64, "base64"));
  console.log("written  " + f.path);
  written++;
}

if (written) console.log("         old copies kept in " + BAK);
else console.log("Already applied - all three are current.");

/* also sweep out any stray .bak left inside app/ from the earlier patch */
let moved = 0;
(function sweepBak(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    if (fs.statSync(fp).isDirectory()) { sweepBak(fp); continue; }
    if (!name.endsWith(".bak")) continue;
    fs.mkdirSync(BAK, { recursive: true });
    fs.renameSync(fp, path.join(BAK, name));
    console.log("moved out " + path.relative(process.cwd(), fp) + " -> " + BAK);
    moved++;
  }
})(path.resolve("app"));

/* nothing should mention renderMessage anywhere under app/ once this is done */
const strays = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const fp = path.join(dir, name);
    if (fs.statSync(fp).isDirectory()) { walk(fp); continue; }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (fs.readFileSync(fp, "utf8").includes("renderMessage")) strays.push(fp);
  }
})(path.resolve("app"));

console.log("");
if (strays.length) {
  console.log("STILL ON THE OLD WAY:");
  for (const s of strays) console.log("  " + path.relative(process.cwd(), s));
  console.log("Send me those too.");
} else {
  console.log("Nothing under app/ mentions renderMessage any more, and no .bak is left in there.");
}

console.log("");
console.log("Now:  npm run build");
