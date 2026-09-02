#!/usr/bin/env node
/* ZakTracking - the four templates that were approved but never sent.
 *
 *   cod_reminder     one nudge when a COD order goes unanswered for 6 hours
 *   refund_initiated the refunds/create webhook, at the refund own amount
 *   review_request   3 days after the parcel was delivered
 *   back_in_stock    served from a waiting list a sold-out card fills in
 *
 * This one patches by looking for a landmark in each file instead of
 * demanding the whole file match, so it still works on a repo that has
 * moved on. It reads everything first: if any landmark is missing, or is
 * there more than once, nothing at all is written.
 *
 * Safe to run twice - a file that already carries the change is skipped.
 */
import fs from "node:fs";
import path from "node:path";

const NEW = [
  {
    "path": "app/lib/followups.server.ts",
    "b64": "LyoqCiAqIFRoZSBtZXNzYWdlcyB0aGF0IG5vIHdlYmhvb2sgY2FuIHRyaWdnZXIuCiAqCiAqIFRocmVlIG9mIG91ciBhcHByb3ZlZCB0ZW1wbGF0ZXMgaGF2ZSBubyBtb21lbnQgb2YgdGhlaXIgb3duOiBub3RoaW5nIGluCiAqIFNob3BpZnkgZmlyZXMgd2hlbiBhIENPRCBvcmRlciBoYXMgZ29uZSB1bmFuc3dlcmVkIGZvciBzaXggaG91cnMsIG9yIHdoZW4KICogYSBwYXJjZWwgd2FzIGRlbGl2ZXJlZCB0aHJlZSBkYXlzIGFnby4gVGhlIGNsb2NrIGhhcyB0byBub3RpY2UuIFRoYXQgaXMKICogd2hhdCB0aGlzIGZpbGUgaXMgLSBpdCBpcyBjYWxsZWQgZnJvbSB0aGUgY3Jvbiwgb25jZSBldmVyeSBmaWZ0ZWVuCiAqIG1pbnV0ZXMsIGFuZCBlYWNoIHN3ZWVwIGlzIHdyaXR0ZW4gc28gdGhhdCBydW5uaW5nIGl0IGFnYWluIGNoYW5nZXMKICogbm90aGluZzogTWVzc2FnZUxvZydzIHVuaXF1ZShbb3JkZXJJZCwgZXZlbnQsIGNoYW5uZWxdKSBpcyB0aGUgbG9jay4KICovCgppbXBvcnQgZGIgZnJvbSAiLi4vZGIuc2VydmVyIjsKaW1wb3J0IHsgcXVldWVNZXNzYWdlLCBldmVudEVuYWJsZWQgfSBmcm9tICIuL25vdGlmeS5zZXJ2ZXIiOwppbXBvcnQgeyBibGFua1ZhcnMsIG1vbmV5IH0gZnJvbSAiLi90ZW1wbGF0ZXMuc2VydmVyIjsKCmNvbnN0IEhPVVIgPSA2MCAqIDYwICogMTAwMDsKCi8qKiBIb3cgbG9uZyB3ZSB3YWl0IGZvciBhbiBhbnN3ZXIgYmVmb3JlIG51ZGdpbmcgb25jZS4gKi8KY29uc3QgQ09EX1FVSUVUX0hPVVJTID0gNjsKLyoqIEFmdGVyIHRoaXMgd2Ugc3RvcCBjaGFzaW5nIC0gdGhlIG9yZGVyIGlzIHN0YWxlLCBub3QgdW5kZWNpZGVkLiAqLwpjb25zdCBDT0RfR0lWRV9VUF9IT1VSUyA9IDQ4OwovKiogTG9uZyBlbm91Z2ggdG8gaGF2ZSB1c2VkIHRoZSB0aGluZywgc2hvcnQgZW5vdWdoIHRvIHN0aWxsIGNhcmUuICovCmNvbnN0IFJFVklFV19BRlRFUl9EQVlTID0gMzsKY29uc3QgUkVWSUVXX0dJVkVfVVBfREFZUyA9IDE0OwoKLyoqCiAqIEEgQ09EIG9yZGVyIGFza2VkIGZvciBjb25maXJtYXRpb24gYW5kIGdvdCBubyByZXBseS4KICoKICogT25seSBvcmRlcnMgdGhhdCBhY3R1YWxseSByZWNlaXZlZCB0aGUgZmlyc3QgbWVzc2FnZSBhcmUgY2hhc2VkLCBhbmQgb25seQogKiBvbmNlLiBBbiBvcmRlciB0aGF0IHdhcyBjb25maXJtZWQsIGRlY2xpbmVkLCBjYW5jZWxsZWQsIG9yIGlzIGFscmVhZHkKICogd2FpdGluZyBvbiBhIGNhbmNlbGxhdGlvbiBpcyBsZWZ0IGFsb25lLgogKi8KZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN3ZWVwQ29kUmVtaW5kZXJzKHNob3A6IGFueSk6IFByb21pc2U8bnVtYmVyPiB7CiAgaWYgKCFldmVudEVuYWJsZWQoc2hvcCwgImNvZF9yZW1pbmRlciIpKSByZXR1cm4gMDsKCiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTsKICBjb25zdCBhc2tlZCA9IGF3YWl0IGRiLm1lc3NhZ2VMb2cuZmluZE1hbnkoewogICAgd2hlcmU6IHsKICAgICAgc2hvcElkOiBzaG9wLmlkLAogICAgICBldmVudDogImNvZF9jb25maXJtIiwKICAgICAgc3RhdHVzOiAic2VudCIsCiAgICAgIHNlbnRBdDogewogICAgICAgIGx0ZTogbmV3IERhdGUobm93IC0gQ09EX1FVSUVUX0hPVVJTICogSE9VUiksCiAgICAgICAgZ3RlOiBuZXcgRGF0ZShub3cgLSBDT0RfR0lWRV9VUF9IT1VSUyAqIEhPVVIpLAogICAgICB9LAogICAgICBvcmRlcklkOiB7IG5vdDogbnVsbCB9LAogICAgfSwKICAgIHRha2U6IDEwMCwKICB9KTsKICBpZiAoIWFza2VkLmxlbmd0aCkgcmV0dXJuIDA7CgogIGNvbnN0IG9yZGVycyA9IGF3YWl0IGRiLm9yZGVyUmVjb3JkLmZpbmRNYW55KHsKICAgIHdoZXJlOiB7CiAgICAgIGlkOiB7IGluOiBhc2tlZC5tYXAoKG06IGFueSkgPT4gbS5vcmRlcklkIGFzIHN0cmluZykgfSwKICAgICAgY29kQ29uZmlybWVkOiBudWxsLAogICAgICBjYW5jZWxsZWRBdDogbnVsbCwKICAgICAgY2FuY2VsUmVxdWVzdGVkQXQ6IG51bGwsCiAgICB9LAogIH0pOwoKICBsZXQgc2VudCA9IDA7CiAgZm9yIChjb25zdCBvIG9mIG9yZGVycykgewogICAgY29uc3QgdiA9IGJsYW5rVmFycygpOwogICAgdi5uYW1lID0gby5jdXN0b21lck5hbWUgfHwgInRoZXJlIjsKICAgIHYub3JkZXIgPSBvLm9yZGVyTnVtYmVyOwogICAgdi5pdGVtID0gby5pdGVtTGluZSB8fCAieW91ciBvcmRlciI7CiAgICB2LmFtb3VudCA9IG1vbmV5KG8ub3V0c3RhbmRpbmcgfHwgby50b3RhbFByaWNlLCBvLmN1cnJlbmN5KTsKCiAgICBjb25zdCByb3cgPSBhd2FpdCBxdWV1ZU1lc3NhZ2UoewogICAgICBzaG9wSWQ6IHNob3AuaWQsCiAgICAgIG9yZGVySWQ6IG8uaWQsCiAgICAgIGV2ZW50OiAiY29kX3JlbWluZGVyIiwKICAgICAgdG86IG8ucGhvbmUsCiAgICAgIHZhcnM6IHYsCiAgICB9KTsKICAgIGlmIChyb3cpIHNlbnQrKzsKICB9CiAgcmV0dXJuIHNlbnQ7Cn0KCi8qKgogKiBBc2sgZm9yIGEgcmV2aWV3LCBhIGZldyBkYXlzIGFmdGVyIHRoZSBwYXJjZWwgbGFuZGVkLgogKgogKiBUaGlzIGlzIGEgTWFya2V0aW5nIHRlbXBsYXRlLCBzbyBpdCBjb3N0cyBtb3JlIHRoYW4gdGhlIHJlc3QgYW5kIGl0IGlzIHRoZQogKiBvbmUgcGVvcGxlIGFyZSBxdWlja2VzdCB0byByZXBvcnQuIE9uZSBwZXIgb3JkZXIsIG5ldmVyIG9uIGFuIG9yZGVyIHRoYXQKICogd2FzIGNhbmNlbGxlZCwgYW5kIG5ldmVyIG9uIGEgZGVsaXZlcnkgb2xkZXIgdGhhbiBhIGZvcnRuaWdodC4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzd2VlcFJldmlld1JlcXVlc3RzKHNob3A6IGFueSk6IFByb21pc2U8bnVtYmVyPiB7CiAgaWYgKCFldmVudEVuYWJsZWQoc2hvcCwgInJldmlldyIpKSByZXR1cm4gMDsKCiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTsKICBjb25zdCBsYW5kZWQgPSBhd2FpdCBkYi5zaGlwbWVudC5maW5kTWFueSh7CiAgICB3aGVyZTogewogICAgICBzdGF0dXM6ICJkZWxpdmVyZWQiLAogICAgICBsYXN0RXZlbnRBdDogewogICAgICAgIGx0ZTogbmV3IERhdGUobm93IC0gUkVWSUVXX0FGVEVSX0RBWVMgKiAyNCAqIEhPVVIpLAogICAgICAgIGd0ZTogbmV3IERhdGUobm93IC0gUkVWSUVXX0dJVkVfVVBfREFZUyAqIDI0ICogSE9VUiksCiAgICAgIH0sCiAgICAgIG9yZGVyOiB7IHNob3BJZDogc2hvcC5pZCwgY2FuY2VsbGVkQXQ6IG51bGwgfSwKICAgIH0sCiAgICBpbmNsdWRlOiB7IG9yZGVyOiB0cnVlIH0sCiAgICB0YWtlOiAxMDAsCiAgfSk7CgogIGxldCBzZW50ID0gMDsKICBmb3IgKGNvbnN0IHMgb2YgbGFuZGVkKSB7CiAgICBjb25zdCBvID0gcy5vcmRlcjsKICAgIGlmICghbykgY29udGludWU7CgogICAgY29uc3QgdiA9IGJsYW5rVmFycygpOwogICAgdi5uYW1lID0gby5jdXN0b21lck5hbWUgfHwgInRoZXJlIjsKICAgIHYuaXRlbSA9IG8uaXRlbUxpbmUgfHwgInlvdXIgb3JkZXIiOwogICAgdi5oYW5kbGUgPSBvLmhhbmRsZSB8fCAiIjsKCiAgICBjb25zdCByb3cgPSBhd2FpdCBxdWV1ZU1lc3NhZ2UoewogICAgICBzaG9wSWQ6IHNob3AuaWQsCiAgICAgIG9yZGVySWQ6IG8uaWQsCiAgICAgIGV2ZW50OiAicmV2aWV3IiwKICAgICAgdG86IG8ucGhvbmUsCiAgICAgIHZhcnM6IHYsCiAgICB9KTsKICAgIGlmIChyb3cpIHNlbnQrKzsKICB9CiAgcmV0dXJuIHNlbnQ7Cn0KCi8qKgogKiBTb21lb25lIGlzIHdhaXRpbmcgZm9yIGEgc29sZC1vdXQgaXRlbSB0byBjb21lIGJhY2suCiAqCiAqIENhbGxlZCBmcm9tIHRoZSBwcm9kdWN0cy91cGRhdGUgd2ViaG9vaywgd2hpY2ggaXMgdGhlIG9ubHkgcGxhY2UgdGhhdAogKiBrbm93cyBhIHZhcmlhbnQncyBzdG9jayBoYXMgbW92ZWQuIG5vdGlmaWVkQXQgaXMgc3RhbXBlZCBiZWZvcmUgdGhlIHNlbmQKICogc28gYSB3ZWJob29rIGFycml2aW5nIHR3aWNlIGNhbm5vdCB0ZWxsIHRoZSBzYW1lIHBlcnNvbiB0d2ljZS4KICovCmV4cG9ydCBhc3luYyBmdW5jdGlvbiBub3RpZnlCYWNrSW5TdG9jaygKICBzaG9wSWQ6IHN0cmluZywKICB2YXJpYW50SWQ6IHN0cmluZywKICBwcmljZTogc3RyaW5nIHwgbnVsbCwKKTogUHJvbWlzZTxudW1iZXI+IHsKICBjb25zdCBzaG9wID0gYXdhaXQgZGIuc2hvcC5maW5kVW5pcXVlKHsgd2hlcmU6IHsgaWQ6IHNob3BJZCB9IH0pOwogIGlmICghc2hvcCB8fCAhZXZlbnRFbmFibGVkKHNob3AsICJiYWNrX2luX3N0b2NrIikpIHJldHVybiAwOwoKICBjb25zdCB3YWl0aW5nID0gYXdhaXQgZGIuc3RvY2tBbGVydC5maW5kTWFueSh7CiAgICB3aGVyZTogeyBzaG9wSWQsIHZhcmlhbnRJZCwgbm90aWZpZWRBdDogbnVsbCB9LAogICAgdGFrZTogMjAwLAogIH0pOwogIGlmICghd2FpdGluZy5sZW5ndGgpIHJldHVybiAwOwoKICBsZXQgc2VudCA9IDA7CiAgZm9yIChjb25zdCBhIG9mIHdhaXRpbmcpIHsKICAgIGNvbnN0IGNsYWltZWQgPSBhd2FpdCBkYi5zdG9ja0FsZXJ0LnVwZGF0ZU1hbnkoewogICAgICB3aGVyZTogeyBpZDogYS5pZCwgbm90aWZpZWRBdDogbnVsbCB9LAogICAgICBkYXRhOiB7IG5vdGlmaWVkQXQ6IG5ldyBEYXRlKCkgfSwKICAgIH0pOwogICAgaWYgKCFjbGFpbWVkLmNvdW50KSBjb250aW51ZTsKCiAgICBjb25zdCB2ID0gYmxhbmtWYXJzKCk7CiAgICB2Lm5hbWUgPSAidGhlcmUiOwogICAgdi5pdGVtID0gYS50aXRsZTsKICAgIHYuYW1vdW50ID0gbW9uZXkocHJpY2UgPz8gYS5wcmljZSwgIklOUiIpOwogICAgdi5oYW5kbGUgPSBhLmhhbmRsZTsKCiAgICBjb25zdCByb3cgPSBhd2FpdCBxdWV1ZU1lc3NhZ2UoewogICAgICBzaG9wSWQsCiAgICAgIGV2ZW50OiAiYmFja19pbl9zdG9jayIsCiAgICAgIHRvOiBhLnBob25lLAogICAgICB2YXJzOiB2LAogICAgfSk7CiAgICBpZiAocm93KSBzZW50Kys7CiAgfQogIHJldHVybiBzZW50Owp9Cg=="
  },
  {
    "path": "app/routes/webhooks.refunds.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgeyBhdXRoZW50aWNhdGUgfSBmcm9tICIuLi9zaG9waWZ5LnNlcnZlciI7CmltcG9ydCB7IGZpcnN0RGVsaXZlcnksIGVuc3VyZVNob3AgfSBmcm9tICIuLi9saWIvd2ViaG9vay5zZXJ2ZXIiOwppbXBvcnQgZGIgZnJvbSAiLi4vZGIuc2VydmVyIjsKaW1wb3J0IHsgcXVldWVNZXNzYWdlLCBldmVudEVuYWJsZWQgfSBmcm9tICIuLi9saWIvbm90aWZ5LnNlcnZlciI7CmltcG9ydCB7IGJsYW5rVmFycywgbW9uZXkgfSBmcm9tICIuLi9saWIvdGVtcGxhdGVzLnNlcnZlciI7CgovKioKICogTW9uZXkgZ29pbmcgYmFjay4KICoKICogQSByZWZ1bmQgaXMgdGhlIG9uZSBtb21lbnQgYSBjdXN0b21lciBpcyBtb3N0IGxpa2VseSB0byB0aGluayB0aGV5IGhhdmUKICogYmVlbiBmb3Jnb3R0ZW4sIHNvIGl0IGlzIHdvcnRoIGEgbWVzc2FnZSBldmVuIHRob3VnaCBpdCBjb3N0cyBvbmUuIFRoZQogKiBhbW91bnQgaXMgYWRkZWQgdXAgZnJvbSB0aGUgcmVmdW5kJ3Mgb3duIHRyYW5zYWN0aW9ucyAtIHRoZSBvcmRlciB0b3RhbAogKiBpcyB0aGUgd3JvbmcgZmlndXJlIHdoZW4gb25seSBwYXJ0IG9mIGl0IGNvbWVzIGJhY2suCiAqLwpleHBvcnQgY29uc3QgYWN0aW9uID0gYXN5bmMgKHsgcmVxdWVzdCB9OiBBY3Rpb25GdW5jdGlvbkFyZ3MpID0+IHsKICBjb25zdCB7IHNob3AsIHRvcGljLCBwYXlsb2FkIH0gPSBhd2FpdCBhdXRoZW50aWNhdGUud2ViaG9vayhyZXF1ZXN0KTsKICBpZiAoIShhd2FpdCBmaXJzdERlbGl2ZXJ5KHJlcXVlc3QsIHRvcGljLCBzaG9wKSkpIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKCiAgY29uc3QgcmVmdW5kID0gcGF5bG9hZCBhcyBhbnk7CiAgY29uc3QgcyA9IGF3YWl0IGVuc3VyZVNob3Aoc2hvcCk7CiAgaWYgKCFldmVudEVuYWJsZWQocywgInJlZnVuZGVkIikpIHJldHVybiBuZXcgUmVzcG9uc2UoKTsKCiAgY29uc3QgcmVjID0gYXdhaXQgZGIub3JkZXJSZWNvcmQuZmluZFVuaXF1ZSh7CiAgICB3aGVyZTogeyBzaG9wSWRfc2hvcGlmeUlkOiB7IHNob3BJZDogcy5pZCwgc2hvcGlmeUlkOiBTdHJpbmcocmVmdW5kLm9yZGVyX2lkKSB9IH0sCiAgfSk7CiAgaWYgKCFyZWMpIHsKICAgIGNvbnNvbGUubG9nKGBbcmVmdW5kc10gb3JkZXIgJHtyZWZ1bmQub3JkZXJfaWR9IGlzIG5vdCBvbmUgb2Ygb3Vyc2ApOwogICAgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwogIH0KCiAgbGV0IHBhaWQgPSAwOwogIGxldCB2aWEgPSAiIjsKICBmb3IgKGNvbnN0IHQgb2YgcmVmdW5kLnRyYW5zYWN0aW9ucyA/PyBbXSkgewogICAgaWYgKHQ/LnN0YXR1cyAmJiB0LnN0YXR1cyAhPT0gInN1Y2Nlc3MiKSBjb250aW51ZTsKICAgIGNvbnN0IG4gPSBOdW1iZXIodD8uYW1vdW50KTsKICAgIGlmIChOdW1iZXIuaXNGaW5pdGUobikpIHBhaWQgKz0gbjsKICAgIGlmICghdmlhICYmIHQ/LmdhdGV3YXkpIHZpYSA9IFN0cmluZyh0LmdhdGV3YXkpOwogIH0KICBpZiAocGFpZCA8PSAwKSB7CiAgICBjb25zb2xlLmxvZyhgW3JlZnVuZHNdICR7cmVjLm9yZGVyTnVtYmVyfTogbm90aGluZyBzZXR0bGVkIHlldCwgbm8gbWVzc2FnZWApOwogICAgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwogIH0KCiAgY29uc3QgdiA9IGJsYW5rVmFycygpOwogIHYubmFtZSA9IHJlYy5jdXN0b21lck5hbWUgfHwgInRoZXJlIjsKICB2LmFtb3VudCA9IG1vbmV5KFN0cmluZyhwYWlkKSwgcmVjLmN1cnJlbmN5KTsKICB2Lm9yZGVyID0gcmVjLm9yZGVyTnVtYmVyOwogIHYuaXRlbSA9IHJlYy5pdGVtTGluZSB8fCAieW91ciBvcmRlciI7CiAgdi5tZXRob2QgPSB2aWEgfHwgcmVjLmdhdGV3YXkgfHwgInlvdXIgb3JpZ2luYWwgcGF5bWVudCBtZXRob2QiOwoKICBhd2FpdCBxdWV1ZU1lc3NhZ2UoewogICAgc2hvcElkOiBzLmlkLAogICAgb3JkZXJJZDogcmVjLmlkLAogICAgZXZlbnQ6ICJyZWZ1bmRlZCIsCiAgICB0bzogcmVjLnBob25lLAogICAgdmFyczogdiwKICB9KTsKCiAgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwp9Owo="
  },
  {
    "path": "app/routes/webhooks.products.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgeyBhdXRoZW50aWNhdGUgfSBmcm9tICIuLi9zaG9waWZ5LnNlcnZlciI7CmltcG9ydCB7IGZpcnN0RGVsaXZlcnksIGVuc3VyZVNob3AgfSBmcm9tICIuLi9saWIvd2ViaG9vay5zZXJ2ZXIiOwppbXBvcnQgeyBub3RpZnlCYWNrSW5TdG9jayB9IGZyb20gIi4uL2xpYi9mb2xsb3d1cHMuc2VydmVyIjsKCi8qKgogKiBTdG9jayBjb21pbmcgYmFjay4KICoKICogVGhpcyBpcyB0aGUgb25seSB3ZWJob29rIHRoYXQgY2FycmllcyBhIHZhcmlhbnQncyBuZXcgcXVhbnRpdHksIHNvIGl0IGlzCiAqIHdoZXJlIHRoZSB3YWl0aW5nIGxpc3QgaXMgc2VydmVkLiBFdmVyeW9uZSB3aG8gYXNrZWQgYWJvdXQgYSB2YXJpYW50IHRoYXQKICogbm93IGhhcyBzdG9jayBnZXRzIHRvbGQgb25jZTsgdGhlIHJlc3Qgb2YgdGhlIHBheWxvYWQgaXMgaWdub3JlZC4KICovCmV4cG9ydCBjb25zdCBhY3Rpb24gPSBhc3luYyAoeyByZXF1ZXN0IH06IEFjdGlvbkZ1bmN0aW9uQXJncykgPT4gewogIGNvbnN0IHsgc2hvcCwgdG9waWMsIHBheWxvYWQgfSA9IGF3YWl0IGF1dGhlbnRpY2F0ZS53ZWJob29rKHJlcXVlc3QpOwogIGlmICghKGF3YWl0IGZpcnN0RGVsaXZlcnkocmVxdWVzdCwgdG9waWMsIHNob3ApKSkgcmV0dXJuIG5ldyBSZXNwb25zZSgpOwoKICBjb25zdCBwcm9kdWN0ID0gcGF5bG9hZCBhcyBhbnk7CiAgY29uc3QgcyA9IGF3YWl0IGVuc3VyZVNob3Aoc2hvcCk7CgogIGZvciAoY29uc3QgdmFyaWFudCBvZiBwcm9kdWN0Py52YXJpYW50cyA/PyBbXSkgewogICAgY29uc3QgcXR5ID0gTnVtYmVyKHZhcmlhbnQ/LmludmVudG9yeV9xdWFudGl0eSk7CiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShxdHkpIHx8IHF0eSA8PSAwKSBjb250aW51ZTsKICAgIGF3YWl0IG5vdGlmeUJhY2tJblN0b2NrKHMuaWQsIFN0cmluZyh2YXJpYW50LmlkKSwgdmFyaWFudD8ucHJpY2UgPz8gbnVsbCk7CiAgfQoKICByZXR1cm4gbmV3IFJlc3BvbnNlKCk7Cn07Cg=="
  },
  {
    "path": "app/routes/proxy.track.stock.tsx",
    "b64": "aW1wb3J0IHR5cGUgeyBBY3Rpb25GdW5jdGlvbkFyZ3MgfSBmcm9tICJyZWFjdC1yb3V0ZXIiOwppbXBvcnQgZGIgZnJvbSAiLi4vZGIuc2VydmVyIjsKaW1wb3J0IHsgYXV0aGVudGljYXRlIH0gZnJvbSAiLi4vc2hvcGlmeS5zZXJ2ZXIiOwppbXBvcnQgeyBzaG9wRnJvbVByb3h5IH0gZnJvbSAiLi4vbGliL3Byb3h5LnNlcnZlciI7CgovKioKICogIlRlbGwgbWUgd2hlbiBpdCBpcyBiYWNrLiIKICoKICogVGhlIHN0b3JlZnJvbnQgcG9zdHMgaGVyZSBmcm9tIGEgc29sZC1vdXQgcHJvZHVjdC4gQWxsIGl0IGxlYXZlcyBiZWhpbmQgaXMKICogYSBudW1iZXIgYWdhaW5zdCBhIHZhcmlhbnQ7IHdoZW4gdGhhdCB2YXJpYW50IGhhcyBzdG9jayBhZ2FpbiB0aGUKICogcHJvZHVjdHMvdXBkYXRlIHdlYmhvb2sgd29ya3MgdGhyb3VnaCB0aGUgbGlzdC4KICoKICogTm90aGluZyBpcyBzZW50IGZyb20gaGVyZSwgc28gdGhlcmUgaXMgbm90aGluZyB0byBhYnVzZSBiZXlvbmQgc2lnbmluZwogKiB1cCAtIGFuZCB0aGUgc2FtZSBudW1iZXIgYWdhaW5zdCB0aGUgc2FtZSB2YXJpYW50IGlzIG9uZSByb3csIG5vdCB0d28uCiAqLwpleHBvcnQgY29uc3QgYWN0aW9uID0gYXN5bmMgKHsgcmVxdWVzdCB9OiBBY3Rpb25GdW5jdGlvbkFyZ3MpID0+IHsKICBhd2FpdCBhdXRoZW50aWNhdGUucHVibGljLmFwcFByb3h5KHJlcXVlc3QpOwoKICBjb25zdCB1cmwgPSBuZXcgVVJMKHJlcXVlc3QudXJsKTsKICBjb25zdCBkb21haW4gPSBzaG9wRnJvbVByb3h5KHVybCk7CiAgaWYgKCFkb21haW4pIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCByZWFzb246ICJTb21ldGhpbmcgd2VudCB3cm9uZyIgfSk7CgogIGNvbnN0IHNob3AgPSBhd2FpdCBkYi5zaG9wLmZpbmRVbmlxdWUoeyB3aGVyZTogeyBkb21haW4gfSB9KTsKICBpZiAoIXNob3ApIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCByZWFzb246ICJTb21ldGhpbmcgd2VudCB3cm9uZyIgfSk7CgogIGNvbnN0IGJvZHkgPSAoYXdhaXQgcmVxdWVzdC5qc29uKCkuY2F0Y2goKCkgPT4gKHt9KSkpIGFzIGFueTsKICBjb25zdCBwaG9uZSA9IFN0cmluZyhib2R5LnBob25lID8/ICIiKS5yZXBsYWNlKC9cRC9nLCAiIikuc2xpY2UoLTEwKTsKICBjb25zdCB2YXJpYW50SWQgPSBTdHJpbmcoYm9keS52YXJpYW50ID8/ICIiKS5yZXBsYWNlKC9cRC9nLCAiIik7CiAgY29uc3QgaGFuZGxlID0gU3RyaW5nKGJvZHkuaGFuZGxlID8/ICIiKS50cmltKCkuc2xpY2UoMCwgMjAwKTsKICBjb25zdCB0aXRsZSA9IFN0cmluZyhib2R5LnRpdGxlID8/ICIiKS50cmltKCkuc2xpY2UoMCwgMjAwKTsKCiAgaWYgKHBob25lLmxlbmd0aCAhPT0gMTApIHsKICAgIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IGZhbHNlLCByZWFzb246ICJFbnRlciB5b3VyIDEwLWRpZ2l0IG1vYmlsZSBudW1iZXIiIH0pOwogIH0KICBpZiAoIXZhcmlhbnRJZCB8fCAhaGFuZGxlKSB7CiAgICByZXR1cm4gUmVzcG9uc2UuanNvbih7IG9rOiBmYWxzZSwgcmVhc29uOiAiU29tZXRoaW5nIHdlbnQgd3JvbmcuIFBsZWFzZSByZWxvYWQgdGhlIHBhZ2UuIiB9KTsKICB9CgogIGNvbnN0IHRvID0gYDkxJHtwaG9uZX1gOwoKICAvLyBTb21lb25lIHdobyBoYXMgc2VudCBTVE9QIGFza2VkIG5vdCB0byBoZWFyIGZyb20gdXMuIFRha2UgdGhlIG51bWJlciwKICAvLyBzYXkgdGhhbmsgeW91LCBhbmQgbmV2ZXIgd3JpdGUgdGhlIHJvdyAtIHJlZnVzaW5nIG91dCBsb3VkIHdvdWxkIGJlIGEKICAvLyB3YXkgdG8gZmluZCBvdXQgd2hvIGhhcyBvcHRlZCBvdXQuCiAgY29uc3QgZ29uZSA9IGF3YWl0IGRiLm9wdE91dC5maW5kVW5pcXVlKHsKICAgIHdoZXJlOiB7IHNob3BJZF9waG9uZTogeyBzaG9wSWQ6IHNob3AuaWQsIHBob25lOiB0byB9IH0sCiAgfSk7CiAgaWYgKGdvbmUpIHJldHVybiBSZXNwb25zZS5qc29uKHsgb2s6IHRydWUgfSk7CgogIGF3YWl0IGRiLnN0b2NrQWxlcnQudXBzZXJ0KHsKICAgIHdoZXJlOiB7IHNob3BJZF9waG9uZV92YXJpYW50SWQ6IHsgc2hvcElkOiBzaG9wLmlkLCBwaG9uZTogdG8sIHZhcmlhbnRJZCB9IH0sCiAgICB1cGRhdGU6IHsgaGFuZGxlLCB0aXRsZSwgcHJpY2U6IGJvZHkucHJpY2UgPyBTdHJpbmcoYm9keS5wcmljZSkgOiBudWxsIH0sCiAgICBjcmVhdGU6IHsKICAgICAgc2hvcElkOiBzaG9wLmlkLAogICAgICBwaG9uZTogdG8sCiAgICAgIHZhcmlhbnRJZCwKICAgICAgaGFuZGxlLAogICAgICB0aXRsZSwKICAgICAgcHJpY2U6IGJvZHkucHJpY2UgPyBTdHJpbmcoYm9keS5wcmljZSkgOiBudWxsLAogICAgfSwKICB9KTsKCiAgcmV0dXJuIFJlc3BvbnNlLmpzb24oeyBvazogdHJ1ZSB9KTsKfTsK"
  }
];
const PATCH = [
  {
    "path": "prisma/schema.prisma",
    "edits": [
      {
        "done": "handle  String?",
        "find": "  address String?\n}",
        "add": "  address String?\n\n  /// Handle of the first real product on the order - \"wireless-massage-gun\".\n  /// The review request's button needs it, and by the time that goes out\n  /// Shopify's payload is long gone.\n  handle  String?\n}"
      },
      {
        "done": "model StockAlert",
        "append": "\n\n/// Someone who asked to be told when a sold-out item is back.\n/// One row per number per variant; notifiedAt is set once the message goes,\n/// so nobody is told twice about the same thing.\nmodel StockAlert {\n  id     String @id @default(cuid())\n  shopId String\n\n  phone     String\n  variantId String\n  handle    String\n  title     String\n  price     String?\n\n  createdAt  DateTime  @default(now())\n  notifiedAt DateTime?\n\n  @@unique([shopId, phone, variantId])\n  @@index([shopId, variantId])\n}\n"
      }
    ]
  },
  {
    "path": "app/lib/webhook.server.ts",
    "edits": [
      {
        "done": "firstHandle",
        "find": "export async function upsertOrder(",
        "add": "/** The handle of the first real product on the order, if Shopify sent one. */\nfunction firstHandle(order: any): string | null {\n  for (const l of order?.line_items ?? []) {\n    const h = l?.product_handle ?? l?.handle ?? null;\n    if (h) return String(h);\n  }\n  return null;\n}\n\nexport async function upsertOrder("
      },
      {
        "done": "handle: firstHandle(order)",
        "find": "    address: shortAddress(order),",
        "add": "    address: shortAddress(order),\n\n    // The review request goes out days later, with a button that opens the\n    // product. By then Shopify's payload is gone, so the handle is kept here.\n    handle: firstHandle(order),"
      }
    ]
  },
  {
    "path": "app/routes/api.cron.tsx",
    "edits": [
      {
        "done": "followups.server",
        "find": "import { sweepCancelRequests } from \"../lib/inbound.server\";",
        "add": "import { sweepCancelRequests } from \"../lib/inbound.server\";\nimport { sweepCodReminders, sweepReviewRequests } from \"../lib/followups.server\";"
      },
      {
        "done": "codReminders: 0",
        "find": "    abandoned2: 0,",
        "add": "    abandoned2: 0,\n    codReminders: 0,\n    reviews: 0,"
      },
      {
        "done": "sweepCodReminders(shop)",
        "find": "  out.cancelTooLate = cx.tooLate;",
        "add": "  out.cancelTooLate = cx.tooLate;\n\n  /* ---------- 5. the messages no webhook can fire ----------\n     This runs for every shop, not only the ones with a tracking key: a COD\n     nudge needs nothing from the courier. */\n  for (const shop of await db.shop.findMany()) {\n    out.codReminders += await sweepCodReminders(shop);\n    out.reviews += await sweepReviewRequests(shop);\n  }"
      }
    ]
  },
  {
    "path": "shopify.app.toml",
    "edits": [
      {
        "done": "/webhooks/refunds",
        "find": "  topics = [ \"orders/cancelled\" ]",
        "add": "  topics = [ \"orders/cancelled\" ]\n\n# Money going back. Shopify fires this per refund, so a partial refund is\n# reported at its own amount, not the order's.\n[[webhooks.subscriptions]]\n  uri    = \"/webhooks/refunds\"\n  topics = [ \"refunds/create\" ]\n\n# The only webhook that carries a variant's new stock level. It is what\n# serves the \"tell me when it is back\" list.\n[[webhooks.subscriptions]]\n  uri    = \"/webhooks/products\"\n  topics = [ \"products/update\" ]"
      }
    ]
  }
];

const writes = [];
let already = 0;

/* ---------- new files ---------- */
for (const f of NEW) {
  const p = path.resolve(f.path);
  const want = Buffer.from(f.b64, "base64");
  if (fs.existsSync(p) && fs.readFileSync(p).equals(want)) { already++; continue; }
  writes.push({ p, want, label: f.path });
}

/* ---------- edits to files that already exist ---------- */
for (const f of PATCH) {
  const p = path.resolve(f.path);
  if (!fs.existsSync(p)) {
    console.error("MISSING  " + f.path + " - is this the zaktracking repo root?");
    process.exit(1);
  }
  let text = fs.readFileSync(p, "utf8");
  const before = text;
  let touched = 0;

  for (const e of f.edits) {
    if (text.includes(e.done)) { continue; }

    if (e.append) { text = text.replace(/\s*$/, "\n") + e.append; touched++; continue; }

    const hits = text.split(e.find).length - 1;
    if (hits !== 1) {
      console.error("NO LANDMARK  " + f.path);
      console.error("         Looked for this, found it " + hits + " times, expected once:");
      console.error("         " + JSON.stringify(e.find.slice(0, 70)));
      console.error("         Nothing has been written. Send me this file and I will rebuild the patch.");
      process.exit(1);
    }
    text = text.replace(e.find, e.add);
    touched++;
  }

  if (!touched || text === before) { already++; continue; }
  writes.push({ p, want: Buffer.from(text, "utf8"), label: f.path });
}

if (!writes.length) {
  console.log("Already applied - " + already + " file(s) are up to date. Nothing to do.");
  process.exit(0);
}

for (const w of writes) {
  fs.mkdirSync(path.dirname(w.p), { recursive: true });
  fs.writeFileSync(w.p, w.want);
  if (!fs.readFileSync(w.p).equals(w.want)) {
    console.error("WRITE FAILED  " + w.label);
    process.exit(1);
  }
  console.log("written  " + w.label);
}

console.log("");
console.log("Done. " + writes.length + " file(s) written, " + already + " already correct.");
console.log("");
console.log("Next, one command at a time:");
console.log("  npx prisma migrate dev --name followups");
console.log("  git add -A");
console.log("  git commit -m \"the four templates that never sent\"");
console.log("  git push");
console.log("  npm run deploy      <- registers the two new webhooks with Shopify");
