import crypto from "node:crypto";

const DEFAULT_PIXEL_ID = "1538982583962183";
const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v24.0";

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length === 10 ? `91${digits}` : digits;
}

export async function sendMetaPurchase(input: {
  value: number;
  currency?: string;
  eventId: string;
  phone?: string | null;
  email?: string | null;
}) {
  const token = process.env.META_CAPI_ACCESS_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID;

  if (!token) {
    console.log("[meta] CAPI skipped: META_CAPI_ACCESS_TOKEN is not configured");
    return;
  }

  const userData: Record<string, string[]> = {};

  if (input.phone) {
    const phone = normalizePhone(input.phone);
    if (phone) userData.ph = [sha256(phone)];
  }

  if (input.email) {
    const email = normalizeEmail(input.email);
    if (email) userData.em = [sha256(email)];
  }

  const payload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: String(input.eventId),
        action_source: "website",
        user_data: userData,
        custom_data: {
          value: Number(input.value),
          currency: input.currency || "INR"
        }
      }
    ]
  };

  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events` +
    `?access_token=${encodeURIComponent(token)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const body = await response.text();

    if (!response.ok) {
      console.log(
        `[meta] CAPI Purchase failed: HTTP ${response.status} ${body.slice(0, 1000)}`
      );
      return;
    }

    console.log(`[meta] CAPI Purchase sent: ${body.slice(0, 500)}`);
  } catch (error: any) {
    console.log(
      `[meta] CAPI Purchase request failed: ${error?.message ?? error}`
    );
  }
}
