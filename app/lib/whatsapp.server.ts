/**
 * WhatsApp Cloud API - the part that sends messages.
 *
 * We talk to Meta directly, with no reseller in between. So each message
 * costs only Meta's own rate (Utility ~₹0.14), with no monthly fee to
 * anyone.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; error: string; permanent: boolean };

/**
 * Sends an approved template.
 *
 * If the customer has not messaged us first we cannot write free-form text -
 * only a pre-approved template can go out. That is why we built
 * seventeen templates.
 */
export async function sendTemplate(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  template: string;
  /** for the body's {{1}} {{2}} ... in this same order */
  params: string[];
  /**
   * The same values in the template's previous numbering, if it has one.
   *
   * A template is edited in WhatsApp Manager and approved hours later; the
   * app is deployed at some third moment. Between those moments the body
   * may still be the old one. Given both orders, the send matches whichever
   * the template really has, so the customer never gets a garbled message
   * and nothing is refused for a wrong count.
   */
  altParams?: string[] | null;
  /** the trailing part of the dynamic URL button, if the template has one */
  buttonParam?: string | null;
  /** force a language code; normally leave this out and let it be resolved */
  language?: string;
  /** lets us look up the template's real language before sending */
  wabaId?: string | null;
}): Promise<SendResult> {
  // ---------------------------------------------------------------
  //  Match what the template actually asks for.
  //
  //  A template is stored on Meta's side, and the merchant can edit it
  //  there at any time. Send five values to a body that now has three
  //  {{n}} and the whole message is refused with 132000 - silently, from
  //  the customer's point of view.
  //
  //  So we read the template first and shape the call to fit it. Our
  //  values are always in the order the body is written in, so dropping
  //  the extra ones from the end leaves a message that still reads
  //  correctly. Too few is the opposite case: there is nothing sensible
  //  to invent, so we refuse rather than send "{{4}}" to a customer.
  // ---------------------------------------------------------------
  // Meta prints a parameter exactly as it is given. A stray space in a
  // value shows up as a gap in the customer's message ("Thanks  Rahul"),
  // so every value is squeezed to single spaces first.
  const tidy = (x: string) => String(x ?? "").replace(/\s+/g, " ").trim();
  let params = opts.params.map(tidy);
  // The other numbering, kept aside for the retry below.
  let other: string[] | null =
    opts.altParams && opts.altParams.length !== opts.params.length ? opts.altParams.map(tidy) : null;
  let buttonParam = opts.buttonParam ?? null;
  let buttonIndex = 0;
  let specLanguage: string | null = null;

  if (opts.wabaId && !opts.language) {
    const spec = await templateSpec(opts.wabaId, opts.token, opts.template);

    if (spec) {
      specLanguage = spec.language;

      if (other && spec.bodyVars === other.length && spec.bodyVars !== params.length) {
        console.log(`[whatsapp] ${opts.template} still has its previous ${other.length} body variables - using that order`);
        [params, other] = [other, params];
      }

      if (spec.bodyVars < params.length) {
        console.log(
          `[whatsapp] ${opts.template} has ${spec.bodyVars} body variables, we hold ` +
            `${params.length} - sending the first ${spec.bodyVars}`,
        );
        params = params.slice(0, spec.bodyVars);
      } else if (spec.bodyVars > params.length) {
        return {
          ok: false,
          error:
            `[params] ${opts.template} needs ${spec.bodyVars} body variables but only ` +
            `${params.length} are available - not sent`,
          permanent: true,
        };
      }

      // A button variable is the same trap in miniature: a static URL
      // button rejects a parameter, and a dynamic one requires it.
      if (!spec.urlVar && buttonParam) {
        console.log(`[whatsapp] ${opts.template} has a static button - dropping its parameter`);
        buttonParam = null;
      } else if (spec.urlVar) {
        buttonIndex = spec.urlIndex;
      }

      if (spec.urlVar && !buttonParam) {
        return {
          ok: false,
          error: `[params] ${opts.template} has a dynamic button but no value for it - not sent`,
          permanent: true,
        };
      }
    }
  }

  function build(list: string[]): any[] {
    const components: any[] = [];

    if (list.length) {
      components.push({
        type: "body",
        parameters: list.map((t) => ({ type: "text", text: t || "-" })),
      });
    }

    if (buttonParam) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(buttonIndex),
        parameters: [{ type: "text", text: buttonParam }],
      });
    }
    return components;
  }

  // ---------------------------------------------------------------
  //  Which language code to send.
  //
  //  A template is not stored under its name alone - it is stored under
  //  (name, language). Ask for "order_placed" in "en" when Meta filed it
  //  under "en_US" and you get error 132001 and nothing is delivered.
  //  Meta's own console files English templates as en_US by default, so
  //  hardcoding "en" was wrong.
  //
  //  So: look the template up in the account and use whatever language it
  //  actually has. If that lookup cannot answer, try the two English codes
  //  in turn rather than guessing once and failing.
  // ---------------------------------------------------------------
  const tries: string[] = [];

  if (opts.language) {
    tries.push(opts.language);
  } else {
    // The template lookup above already told us the language, so this
    // costs nothing extra.
    if (specLanguage) tries.push(specLanguage);
    for (const fallback of ["en_US", "en"]) {
      if (!tries.includes(fallback)) tries.push(fallback);
    }
  }

  let last: SendResult = { ok: false, error: "no language to try", permanent: true };

  for (const lang of tries) {
    last = await attempt(lang, params);
    // 132000 is a body whose variable count is not the one we read - an
    // edit still in review, or one approved a moment ago - so the other
    // numbering is tried once before giving up.
    if (!last.ok && last.error.startsWith("[132000]") && other) {
      console.log(`[whatsapp] ${opts.template} refused ${params.length} variables - retrying with ${other.length}`);
      last = await attempt(lang, other);
    }
    // 132001 is the only error worth retrying with a different language.
    if (last.ok || !last.error.startsWith("[132001]")) return last;
  }
  return last;

  async function attempt(lang: string, list: string[]): Promise<SendResult> {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.to,
    type: "template",
    template: {
      name: opts.template,
      language: { code: lang },
      components: build(list),
    },
  };

  try {
    const res = await fetch(`${GRAPH}/${opts.phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json: any = await res.json().catch(() => ({}));

    if (res.ok && json?.messages?.[0]?.id) {
      return { ok: true, id: json.messages[0].id };
    }

    const err = json?.error ?? {};
    const code = Number(err.code ?? 0);
    const msg =
      [err.message, err.error_data?.details].filter(Boolean).join(" - ") ||
      `HTTP ${res.status}`;

    // ---------------------------------------------------------------
    //  Which errors are worth retrying, and which are not.
    //
    //  Wrong number, template does not exist, customer has blocked us -
    //  resending will not fix any of these. We treat them as permanent
    //  and drop them from the queue.
    //
    //  Rate limits or Meta's own server being down - these clear up after
    //  a while, so they should be retried.
    // ---------------------------------------------------------------
    const permanent = [100, 131009, 131026, 131047, 132000, 132001, 132005, 132007, 132012, 132015].includes(code);

    return { ok: false, error: `[${code}] ${msg}`, permanent };
  } catch (e: any) {
    // the network dropped - retry later
    return { ok: false, error: String(e?.message ?? e), permanent: false };
  }
  }
}

/**
 * Plain text, no template.
 *
 * Meta allows this only inside the 24 hours after the customer wrote to
 * us - which is exactly when we use it, in the reply to their own message.
 * No category, so nothing here can be reclassified as marketing, and no
 * per-user marketing limit can hold it back.
 */
export async function sendText(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  body: string;
}): Promise<SendResult> {
  return post(opts.phoneNumberId, opts.token, {
    to: opts.to,
    type: "text",
    text: { preview_url: false, body: opts.body.slice(0, 4096) },
  });
}

/**
 * Text with up to three reply buttons under it - "Confirm order",
 * "Cancel order" - the same buttons a template can carry, but composed on
 * the spot. Only inside the 24-hour window, like every other free-form
 * message. A tap comes back to the webhook as the button's title.
 */
export async function sendButtons(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  body: string;
  buttons: string[];
}): Promise<SendResult> {
  return post(opts.phoneNumberId, opts.token, {
    to: opts.to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: opts.body.slice(0, 1024) },
      action: {
        buttons: opts.buttons.slice(0, 3).map((title, i) => ({
          type: "reply",
          reply: { id: `b${i + 1}`, title: title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Text with a menu behind one button - the customer taps it, picks a row,
 * and the row's title comes back to the webhook exactly like a typed reply.
 * Up to ten rows; Meta caps the row title at 24 characters and the
 * description at 72.
 */
export async function sendList(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  body: string;
  button: string;
  rows: { title: string; description?: string }[];
}): Promise<SendResult> {
  return post(opts.phoneNumberId, opts.token, {
    to: opts.to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: opts.body.slice(0, 1024) },
      action: {
        button: opts.button.slice(0, 20),
        sections: [
          {
            rows: opts.rows.slice(0, 10).map((r, i) => ({
              id: `r${i + 1}`,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

/** One call to the messages endpoint for anything that is not a template. */
async function post(
  phoneNumberId: string,
  token: string,
  message: Record<string, unknown>,
): Promise<SendResult> {
  try {
    const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...message,
      }),
    });

    const json: any = await res.json().catch(() => ({}));
    if (res.ok && json?.messages?.[0]?.id) return { ok: true, id: json.messages[0].id };

    const err = json?.error ?? {};
    const code = Number(err.code ?? 0);
    const msg = err.message || `HTTP ${res.status}`;
    // 131047 is the window having closed - nothing to retry there either.
    const permanent = [100, 131009, 131026, 131047, 131051].includes(code);
    return { ok: false, error: `[${code}] ${msg}`, permanent };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e), permanent: false };
  }
}

/**
 * Plain text with a real button under it, and still no template.
 *
 * Meta calls this an interactive call-to-action URL message. Inside an
 * open service window any message type is allowed, so this needs no
 * approval and carries no category - and a labelled button is tapped far
 * more often than a raw link, which people are right to distrust.
 *
 * Label is capped at 20 characters and the body at 1024 by Meta; both are
 * trimmed here rather than left for the API to refuse.
 */
export async function sendCta(opts: {
  phoneNumberId: string;
  token: string;
  to: string;
  body: string;
  label: string;
  url: string;
}): Promise<SendResult> {
  return post(opts.phoneNumberId, opts.token, {
    to: opts.to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: opts.body.slice(0, 1024) },
      action: {
        name: "cta_url",
        parameters: { display_text: opts.label.slice(0, 20), url: opts.url },
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Template name -> language                                          */
/* ------------------------------------------------------------------ */

type Cached = { at: number; list: any[] };
const tplCache = new Map<string, Cached>();
const TTL = 5 * 60 * 1000;

/** The whole template list for an account, cached for five minutes. */
async function allTemplates(wabaId: string, token: string, force = false): Promise<any[]> {
  const hit = tplCache.get(wabaId);
  if (!force && hit && Date.now() - hit.at < TTL) return hit.list;

  const r = await listTemplates(wabaId, token);
  if (!r.ok) return hit?.list ?? [];

  tplCache.set(wabaId, { at: Date.now(), list: r.templates });
  return r.templates;
}

/**
 * One template by name. An approved entry wins over a pending one, because
 * only an approved template can actually be sent.
 */
export async function findTemplate(wabaId: string, token: string, name: string) {
  let matches = (await allTemplates(wabaId, token)).filter((t: any) => t?.name === name);
  if (matches.length === 0) {
    // Just created, and our cache predates it - look once more, fresh.
    matches = (await allTemplates(wabaId, token, true)).filter((t: any) => t?.name === name);
  }
  if (matches.length === 0) return null;
  return matches.find((t: any) => t.status === "APPROVED") ?? matches[0];
}

/**
 * What a template actually needs before it can be sent: how many body
 * variables, and whether its URL button carries one.
 *
 * Getting this wrong is its own error (132000, wrong number of parameters),
 * so it is worth reading rather than assuming. hello_world, for instance,
 * takes none at all.
 */
export async function templateSpec(wabaId: string, token: string, name: string) {
  const t = await findTemplate(wabaId, token, name);
  if (!t) return null;

  let bodyVars = 0;
  let urlVar = false;
  // Which button the variable belongs to. A template may carry two URL
  // buttons - Pay Now and Track order, say - and the parameter has to be
  // addressed to the right one or it lands in the wrong link.
  let urlIndex = 0;

  for (const c of t.components ?? []) {
    const type = String(c?.type ?? "").toUpperCase();

    if (type === "BODY") {
      for (const m of String(c?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
        bodyVars = Math.max(bodyVars, Number(m[1]));
      }
    }
    if (type === "BUTTONS") {
      const list = c?.buttons ?? [];
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (String(b?.type ?? "").toUpperCase() === "URL" && /\{\{\s*\d+\s*\}\}/.test(String(b?.url ?? ""))) {
          if (!urlVar) urlIndex = i;
          urlVar = true;
        }
      }
    }
  }

  return {
    name: t.name as string,
    language: t.language as string,
    status: t.status as string,
    bodyVars,
    urlVar,
    urlIndex,
  };
}

/**
 * Every template name in the account with the language it was filed under.
 * Cached for five minutes - a merchant does not add templates every second,
 * and asking Meta before each message would be slow and rate-limited.
 */
/** The language this one template is filed under, or null if unknown. */
export async function resolveLanguage(
  wabaId: string,
  token: string,
  name: string,
): Promise<string | null> {
  const t = await findTemplate(wabaId, token, name);
  return t?.language ?? null;
}

/** Tells you whether the number and token are valid without sending a message. */
export async function checkCredentials(phoneNumberId: string, token: string) {
  try {
    const res = await fetch(
      `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && json?.id) {
      return {
        ok: true as const,
        number: json.display_phone_number as string,
        name: json.verified_name as string,
        quality: json.quality_rating as string,
      };
    }
    return { ok: false as const, error: json?.error?.message ?? `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}

/** Which templates have been approved - for display on the admin page. */
export async function listTemplates(wabaId: string, token: string) {
  try {
    const res = await fetch(
      `${GRAPH}/${wabaId}/message_templates?fields=name,status,category,language,components&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json: any = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(json?.data)) {
      return { ok: true as const, templates: json.data as any[] };
    }
    return { ok: false as const, error: json?.error?.message ?? `HTTP ${res.status}` };
  } catch (e: any) {
    return { ok: false as const, error: String(e?.message ?? e) };
  }
}
