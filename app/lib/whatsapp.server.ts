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
  /** the trailing part of the dynamic URL button, if the template has one */
  buttonParam?: string | null;
  /** force a language code; normally leave this out and let it be resolved */
  language?: string;
  /** lets us look up the template's real language before sending */
  wabaId?: string | null;
}): Promise<SendResult> {
  const components: any[] = [];

  if (opts.params.length) {
    components.push({
      type: "body",
      parameters: opts.params.map((t) => ({ type: "text", text: t || "-" })),
    });
  }

  if (opts.buttonParam) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: opts.buttonParam }],
    });
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
    if (opts.wabaId) {
      const found = await resolveLanguage(opts.wabaId, opts.token, opts.template);
      if (found) tries.push(found);
    }
    for (const fallback of ["en_US", "en"]) {
      if (!tries.includes(fallback)) tries.push(fallback);
    }
  }

  let last: SendResult = { ok: false, error: "no language to try", permanent: true };

  for (const lang of tries) {
    last = await attempt(lang);
    // 132001 is the only error worth retrying with a different language.
    if (last.ok || !last.error.startsWith("[132001]")) return last;
  }
  return last;

  async function attempt(lang: string): Promise<SendResult> {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: opts.to,
    type: "template",
    template: {
      name: opts.template,
      language: { code: lang },
      components,
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

  for (const c of t.components ?? []) {
    const type = String(c?.type ?? "").toUpperCase();

    if (type === "BODY") {
      for (const m of String(c?.text ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
        bodyVars = Math.max(bodyVars, Number(m[1]));
      }
    }
    if (type === "BUTTONS") {
      for (const b of c?.buttons ?? []) {
        if (String(b?.type ?? "").toUpperCase() === "URL" && /\{\{\s*\d+\s*\}\}/.test(String(b?.url ?? ""))) {
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
