const LANGUAGE_NAMES = {
  ta: "Tamil",
  hi: "Hindi",
  te: "Telugu",
  ml: "Malayalam",
  kn: "Kannada",
  bn: "Bengali",
  es: "Spanish",
  fr: "French",
  de: "German",
};

const MAX_ITEMS = 12;
const MAX_REQUEST_BYTES = 65536;
const MAX_TEXT_CHARACTERS = 20000;
const DEFAULT_DAILY_ITEM_QUOTA = 100;

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function validArticleUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!Object.hasOwn(LANGUAGE_NAMES, payload.language)) return null;
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > MAX_ITEMS) return null;

  const ids = new Set();
  let totalTextCharacters = 0;
  const items = [];
  for (const raw of payload.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    if (!id || id.length > 2048 || ids.has(id)) return null;
    if (!title || title.length > 500 || summary.length > 1600 || !validArticleUrl(raw.url)) return null;
    ids.add(id);
    totalTextCharacters += title.length + summary.length;
    items.push({ id, url: raw.url, title, summary });
  }
  if (totalTextCharacters > MAX_TEXT_CHARACTERS) return null;
  return { language: payload.language, items };
}

function parseProviderTranslations(payload, expectedItems) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.translations) || parsed.translations.length !== expectedItems.length) return null;

  const expectedIds = new Set(expectedItems.map((item) => item.id));
  const translations = new Map();
  for (const item of parsed.translations) {
    if (!item || typeof item.id !== "string" || !expectedIds.has(item.id) || translations.has(item.id)) return null;
    if (typeof item.title !== "string" || !item.title.trim() || typeof item.summary !== "string") return null;
    if (item.title.length > 2500 || item.summary.length > 6000) return null;
    translations.set(item.id, { title: item.title.trim(), summary: item.summary.trim() });
  }
  return translations.size === expectedItems.length ? translations : null;
}

function providerConfiguration(env) {
  const endpoint = typeof env.AI_TRANSLATION_ENDPOINT === "string" ? env.AI_TRANSLATION_ENDPOINT.trim() : "";
  const apiKey = typeof env.AI_TRANSLATION_API_KEY === "string" ? env.AI_TRANSLATION_API_KEY.trim() : "";
  const model = typeof env.AI_TRANSLATION_MODEL === "string" ? env.AI_TRANSLATION_MODEL.trim() : "";
  if (!endpoint || !apiKey || !model) {
    return { error: "Translation service is not configured." };
  }

  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return { error: "Translation service configuration is invalid." };
  }
  if (parsedEndpoint.protocol !== "https:") {
    return { error: "Translation service configuration is invalid." };
  }
  return { endpoint: parsedEndpoint.href, apiKey, model };
}

async function translateWithProvider(configuration, language, items) {

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(configuration.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: configuration.model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `Translate only the supplied news headlines and short summaries into ${LANGUAGE_NAMES[language]}. Preserve names, numbers, dates, quotations, source meaning, and the original facts. Do not add, infer, explain, summarize further, or omit information. Return only valid JSON in the shape {"translations":[{"id":"...","title":"...","summary":"..."}]}. Include exactly one result for every supplied id. Leave an empty summary empty.`,
          },
          {
            role: "user",
            content: JSON.stringify({ items: items.map(({ id, title, summary }) => ({ id, title, summary })) }),
          },
        ],
      }),
      signal: controller.signal,
    });
  } catch {
    console.error("Translation provider request failed.");
    return { error: "Translation service is temporarily unavailable.", status: 502 };
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    console.error(`Translation provider returned HTTP ${response.status}.`);
    return { error: "Translation service is temporarily unavailable.", status: 502 };
  }

  let result;
  try {
    result = await response.json();
  } catch {
    console.error("Translation provider returned invalid JSON.");
    return { error: "Translation service returned an invalid response.", status: 502 };
  }
  const translations = parseProviderTranslations(result, items);
  if (!translations) {
    console.error("Translation provider returned an invalid translation payload.");
    return { error: "Translation service returned an invalid response.", status: 502 };
  }
  return { translations };
}

function dailyQuota(env) {
  const raw = env.TRANSLATION_DAILY_ITEM_QUOTA;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAILY_ITEM_QUOTA;
  const quota = Number(raw);
  return Number.isInteger(quota) && quota >= 1 && quota <= 10000 ? quota : null;
}

function retryAfterSeconds(now = new Date()) {
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "POST" });
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) {
    return jsonResponse({ error: "Cross-origin requests are not allowed." }, 403);
  }
  const contentType = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Translation request is too large." }, 413);
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ error: "Translation request is too large." }, 413);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const input = validInput(payload);
  if (!input) {
    return jsonResponse({ error: "Translation request contains invalid language or article data." }, 400);
  }
  if (!env.TRANSLATION_DB) {
    return jsonResponse({ error: "Translation storage is not configured." }, 503);
  }

  const prepared = [];
  for (const item of input.items) {
    prepared.push({
      ...item,
      articleId: await sha256(`${item.id}\n${item.url}`),
      contentVersion: await sha256(`${item.title}\n${item.summary}`),
    });
  }

  const translations = new Map();
  const misses = [];
  try {
    for (const item of prepared) {
      const cached = await env.TRANSLATION_DB.prepare(
        "SELECT translated_title, translated_summary FROM news_translations WHERE article_id = ? AND language = ? AND content_version = ?",
      ).bind(item.articleId, input.language, item.contentVersion).first();
      if (cached) {
        translations.set(item.id, { title: cached.translated_title, summary: cached.translated_summary });
      } else {
        misses.push(item);
      }
    }
  } catch {
    console.error("Translation cache lookup failed.");
    return jsonResponse({ error: "Translation cache is temporarily unavailable." }, 503);
  }

  if (!misses.length) {
    return jsonResponse({
      language: input.language,
      translations: prepared.map((item) => ({ id: item.id, ...translations.get(item.id) })),
    });
  }

  const quota = dailyQuota(env);
  if (quota === null) {
    return jsonResponse({ error: "Translation quota configuration is invalid." }, 503);
  }
  const provider = providerConfiguration(env);
  if (provider.error) {
    return jsonResponse({ error: provider.error }, 503);
  }

  const ipAddress = request.headers.get("CF-Connecting-IP") || "unknown";
  const clientHash = await sha256(ipAddress);
  const utcDay = new Date().toISOString().slice(0, 10);
  try {
    const reservation = await env.TRANSLATION_DB.prepare(
      `INSERT INTO translation_daily_usage (client_hash, day_utc, translated_items)
       VALUES (?, ?, ?)
       ON CONFLICT(client_hash, day_utc) DO UPDATE
       SET translated_items = translated_items + excluded.translated_items
       WHERE translation_daily_usage.translated_items + excluded.translated_items <= ?
       RETURNING translated_items`,
    ).bind(clientHash, utcDay, misses.length, quota).first();
    if (!reservation) {
      return jsonResponse(
        { error: "Daily translation quota reached. Try again after 00:00 UTC." },
        429,
        { "Retry-After": String(retryAfterSeconds()) },
      );
    }
  } catch {
    console.error("Translation quota reservation failed.");
    return jsonResponse({ error: "Translation quota is temporarily unavailable." }, 503);
  }

  const providerResult = await translateWithProvider(provider, input.language, misses);
  if (providerResult.error) {
    return jsonResponse({ error: providerResult.error }, providerResult.status);
  }

  const translatedMisses = providerResult.translations;
  try {
    for (const item of misses) {
      const translated = translatedMisses.get(item.id);
      await env.TRANSLATION_DB.prepare(
        `INSERT INTO news_translations
          (article_id, language, content_version, translated_title, translated_summary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(article_id, language, content_version) DO NOTHING`,
      ).bind(item.articleId, input.language, item.contentVersion, translated.title, translated.summary).run();
      translations.set(item.id, translated);
    }
  } catch {
    console.error("Translation cache write failed.");
    return jsonResponse({ error: "Translation could not be cached. Please retry." }, 503);
  }

  return jsonResponse({
    language: input.language,
    translations: prepared.map((item) => ({ id: item.id, ...translations.get(item.id) })),
  });
}
