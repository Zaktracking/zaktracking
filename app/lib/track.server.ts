import crypto from "crypto";

/**
 * 17TRACK client.
 *
 * This is the most important file in the app. Shopify never tells us that a
 * parcel is "out for delivery", or that it has been "delivered", or that the
 * address turned out to be wrong. All of that news sits with the courier.
 * 17TRACK picks it up from 2500+ couriers and hands it to us in one shape.
 *
 * Free plan: we can register 100 tracking numbers a month.
 * Once a number is registered, its updates cost us nothing.
 */

const BASE = "https://api.17track.net/track/v2.2";

export type ApiResult = {
  ok: boolean;
  code?: number;
  error?: string;
  accepted: any[];
  rejected: any[];
};

async function call(path: string, key: string, body: any): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "17token": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    return { ok: false, error: `network: ${e?.message ?? e}`, accepted: [], rejected: [] };
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* handled below */
  }

  if (!json) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, accepted: [], rejected: [] };
  }
  if (json.code !== 0) {
    const msg =
      json?.data?.errors?.[0]?.message ??
      json?.message ??
      `17track code ${json.code}`;
    return { ok: false, code: json.code, error: String(msg), accepted: [], rejected: [] };
  }
  return {
    ok: true,
    accepted: json?.data?.accepted ?? [],
    rejected: json?.data?.rejected ?? [],
  };
}

/** We cannot send more than 40 numbers at a time - the API's own limit. */
export function chunk<T>(arr: T[], size = 40): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type RegisterItem = {
  number: string;
  carrier?: number;
  order_no?: string;
  tag?: string;
  param?: string;
};

/**
 * Registering a number spends quota. So every number goes in only once.
 * One that is already registered comes back with code -18019901, and that
 * is not an error - it means "yes, this one is already running".
 */
export async function registerNumbers(key: string, items: RegisterItem[]) {
  return call(
    "register",
    key,
    items.map((i) => ({ ...i, auto_detection: true, lang: "en" })),
  );
}

export async function getTrackInfo(key: string, numbers: string[]) {
  return call("gettrackinfo", key, numbers.map((n) => ({ number: n })));
}

export async function deleteTrack(key: string, numbers: string[]) {
  return call("deletetrack", key, numbers.map((n) => ({ number: n })));
}

export async function getQuota(key: string) {
  const r = await call("getquota", key, {});
  return r;
}

/** The "already registered" error is to be treated as a success. */
export const ALREADY_REGISTERED = -18019901;
export const NOT_REGISTERED = -18019902;
export const NO_CARRIER = -18019903;
export const QUOTA_OVER = -18019908;

/* ------------------------------------------------------------------ */
/*  Webhook signature                                                 */
/* ------------------------------------------------------------------ */

/**
 * 17TRACK sends a `sign` header on its push:
 *     sha256(whole_body + "/" + secret_key)
 *
 * Without it anyone could POST to our URL and have "your parcel has been
 * delivered" sent out. So this check is not to be dropped.
 */
export function verifySign(raw: string, header: string | null, key: string): boolean {
  if (!header || !key) return false;
  const got = header.trim().toLowerCase();
  const a = crypto.createHash("sha256").update(raw + "/" + key, "utf8").digest("hex");
  const b = crypto.createHash("sha256").update(raw + key, "utf8").digest("hex");
  return got === a || got === b;
}

/* ------------------------------------------------------------------ */
/*  Giving the response one shape                                     */
/* ------------------------------------------------------------------ */

export type Norm = {
  /** our own status: pending | info_received | in_transit |
   *  out_for_delivery | delivered | exception | returned */
  status: string;
  /** 17track's own main status */
  raw: string;
  sub: string;
  desc: string;
  location: string;
  time: Date | null;
  carrierName: string;
  carrierCode: string | null;
  /** how many times delivery was attempted and failed */
  attempts: number;
  events: { time: Date | null; desc: string; location: string }[];
};

function asDate(x: any): Date | null {
  if (!x) return null;
  const d = new Date(String(x));
  return isNaN(d.getTime()) ? null : d;
}

/**
 * 17TRACK's answer comes in several shapes - one in gettrackinfo, a slightly
 * different one in the push. That is why `??` sits everywhere here. A renamed
 * field must still not bring the app down, we only lose that field's data.
 */
export function normalize(node: any): Norm {
  const ti = node?.track_info ?? node?.tracking_info ?? node ?? {};
  const ls = ti?.latest_status ?? ti?.latestStatus ?? {};
  const le = ti?.latest_event ?? ti?.latestEvent ?? {};

  const providers =
    ti?.tracking?.providers ?? ti?.providers ?? [];
  const p0 = providers[0] ?? {};
  const provider = p0?.provider ?? {};

  const rawEvents: any[] = [];
  for (const p of providers) for (const e of p?.events ?? []) rawEvents.push(e);
  rawEvents.sort((a, b) => {
    const ta = asDate(a?.time_iso ?? a?.time_utc)?.getTime() ?? 0;
    const tb = asDate(b?.time_iso ?? b?.time_utc)?.getTime() ?? 0;
    return tb - ta;
  });

  const raw = String(ls?.status ?? "");
  const sub = String(ls?.sub_status ?? ls?.subStatus ?? "");

  let status = "pending";
  if (raw === "InfoReceived") status = "info_received";
  else if (raw === "InTransit" || raw === "AvailableForPickup") status = "in_transit";
  else if (raw === "OutForDelivery") status = "out_for_delivery";
  else if (raw === "Delivered") status = "delivered";
  else if (raw === "DeliveryFailure") status = "exception";
  else if (raw === "Exception") status = /Return/i.test(sub) ? "returned" : "exception";
  else if (raw === "Expired") status = "exception";

  const attempts = rawEvents.filter((e) =>
    /DeliveryFailure/i.test(String(e?.sub_status ?? "")),
  ).length;

  return {
    status,
    raw,
    sub,
    desc: String(le?.description ?? rawEvents[0]?.description ?? "").trim(),
    location: String(le?.location ?? rawEvents[0]?.location ?? "").trim(),
    time: asDate(le?.time_iso ?? le?.time_utc ?? rawEvents[0]?.time_iso),
    carrierName: String(provider?.name ?? node?.carrier_name ?? "").trim(),
    carrierCode:
      node?.carrier != null ? String(node.carrier) : provider?.key != null ? String(provider.key) : null,
    attempts,
    events: rawEvents.slice(0, 40).map((e) => ({
      time: asDate(e?.time_iso ?? e?.time_utc),
      desc: String(e?.description ?? "").trim(),
      location: String(e?.location ?? "").trim(),
    })),
  };
}

/** The words shown to the customer. */
export const STATUS_LABEL: Record<string, string> = {
  pending: "Order confirmed",
  info_received: "Picked up soon",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  exception: "Needs attention",
  returned: "Returning to us",
};

/**
 * The reason a delivery failed, in plain language, written to follow the
 * template's "could not be delivered today because ...". Sending the
 * customer "DeliveryFailure_NoBody" is useless, and the courier's own
 * words ("Consignee unavailable") are not much better - so the code and
 * the description are both read, and one of a few plain phrases comes out.
 */
export function failReason(sub: string, desc: string): string {
  const s = `${sub ?? ""} ${desc ?? ""}`.toLowerCase();

  if (/nobody|no body|unavailable|not available|no one|nobody at|not at home|absent|not present/.test(s))
    return "nobody was available at the address";
  if (/not reachable|unreachable|no response|not responding|not answering|switched off|ringing|phone not|not contact|unable to contact|could not contact|not picking|no answer/.test(s))
    return "your phone could not be reached";
  if (/invalidaddress|invalid address|incomplete|incorrect address|wrong address|not found|not located|unable to locate|locate|landmark|insufficient/.test(s))
    return "the address was incomplete";
  if (/closed|shut|security|no entry|not allowed|restricted|no access/.test(s))
    return "the address was closed";
  if (/rejected|refused|refuse|declin|reject|not accept/.test(s))
    return "the parcel was refused at the door";
  if (/cod|cash|amount|payment|money/.test(s))
    return "the cash amount was not ready";
  if (/out of delivery area|out of area|\boda\b|route|not serviceable|non.serviceable|beyond|remote area/.test(s))
    return "the area was off the courier's route today";
  if (/delay/.test(s))
    return "the parcel was delayed in transit";
  return "the courier could not complete the attempt";
}

export function inWords(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six"][n] ?? String(n);
}
