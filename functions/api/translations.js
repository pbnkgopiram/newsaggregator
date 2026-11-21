const SUPPORTED_LOCALES = new Set(["en", "ta", "hi", "te", "ml", "kn", "bn", "es", "fr", "de"]);

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }
  const language = new URL(request.url).searchParams.get("language");
  if (!SUPPORTED_LOCALES.has(language)) {
    return jsonResponse({ error: "Unsupported language." }, 400);
  }
  if (!env.TRANSLATION_DB) {
    return jsonResponse({ error: "Translation storage is not configured." }, 503);
  }

  try {
    const statement = language === "en"
      ? env.TRANSLATION_DB.prepare(
        `SELECT article_id, story_key, title, summary
         FROM news_articles
         ORDER BY published_at DESC
         LIMIT 500`,
      )
      : env.TRANSLATION_DB.prepare(
        `SELECT a.article_id, a.story_key,
                t.translated_title AS title, t.translated_summary AS summary
         FROM news_articles AS a
         JOIN news_translations AS t
           ON t.article_id = a.article_id
          AND t.content_version = a.content_version
          AND t.language = ?
         ORDER BY a.published_at DESC
         LIMIT 500`,
      ).bind(language);
    const result = await statement.all();
    return jsonResponse({ language, articles: result.results || [] });
  } catch (error) {
    console.error("Could not load indexed translations:", error);
    return jsonResponse({ error: "Indexed translations are temporarily unavailable." }, 503);
  }
}
