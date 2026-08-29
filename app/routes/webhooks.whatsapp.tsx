/**
 * Where WhatsApp replies arrive.
 *
 * A number on the Cloud API cannot be opened in the ordinary WhatsApp
 * Business app, so this endpoint is the only way a customer's reply is ever
 * seen. Without it the Confirm and Cancel buttons are decoration.
 *
 * Meta calls this twice over its life:
 *   GET  - once, to verify the Callback URL (echo hub.challenge back)
 *   POST - for every inbound message and every delivery status, forever
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { handleInbound } from "../lib/inbound.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.WA_VERIFY_TOKEN || "";

  if (!expected) {
    console.log("[wa-webhook] WA_VERIFY_TOKEN is not set in the environment");
    return new Response("not configured", { status: 500 });
  }

  if (mode === "subscribe" && token === expected && challenge) {
    console.log("[wa-webhook] verification succeeded");
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  console.log("[wa-webhook] verification failed - token matched:", token === expected);
  return new Response("forbidden", { status: 403 });
}

/** The readable text of a message, whatever type it came in as. */
function textOf(message: any): { text: string; kind: string } {
  const type = String(message?.type ?? "");

  if (type === "text") {
    return { text: String(message.text?.body ?? ""), kind: "text" };
  }
  if (type === "button") {
    return {
      text: String(message.button?.text ?? message.button?.payload ?? ""),
      kind: "button",
    };
  }
  if (type === "interactive") {
    const i = message.interactive ?? {};
    return {
      text: String(
        i.button_reply?.title ?? i.button_reply?.id ?? i.list_reply?.title ?? "",
      ),
      kind: "interactive",
    };
  }
  return { text: `[${type}]`, kind: type || "other" };
}

export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();

  // Meta disables a webhook that is slow or throws, so this never rethrows
  // and always answers 200.
  try {
    const body = JSON.parse(raw);

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};

        // One installation can have several numbers. The payload says which
        // one it was, and that is what tells us whose shop this is.
        const phoneNumberId = String(value?.metadata?.phone_number_id ?? "");
        const shop = phoneNumberId
          ? await db.shop.findFirst({ where: { waPhoneNumberId: phoneNumberId } })
          : null;

        for (const message of value.messages ?? []) {
          const { text, kind } = textOf(message);
          const from = String(message.from ?? "");

          if (!shop) {
            console.log(
              `[wa-inbound] ${from} -> "${text}" but no shop uses phone number id ${phoneNumberId}`,
            );
            continue;
          }

          await handleInbound({
            shopId: shop.id,
            domain: shop.domain,
            waMessageId: String(message.id ?? `${from}-${message.timestamp ?? Date.now()}`),
            from,
            text,
            kind,
          });
        }

        // Delivery receipts. Useful when a message says "sent" on our side
        // but never reached the phone.
        for (const status of value.statuses ?? []) {
          const id = String(status?.id ?? "");
          const state = String(status?.status ?? "");
          if (!id || !state) continue;

          if (state === "failed") {
            const reason =
              status?.errors?.[0]?.title ?? status?.errors?.[0]?.message ?? "failed";
            await db.messageLog
              .updateMany({
                where: { providerId: id },
                data: { status: "failed", error: String(reason) },
              })
              .catch(() => {});
            console.log(`[wa-status] ${status.recipient_id} -> failed: ${reason}`);
          } else if (state === "read" || state === "delivered") {
            console.log(`[wa-status] ${status.recipient_id} -> ${state}`);
          }
        }
      }
    }
  } catch (error) {
    console.log("[wa-webhook] could not handle payload:", error);
  }

  return new Response("ok", { status: 200 });
}
