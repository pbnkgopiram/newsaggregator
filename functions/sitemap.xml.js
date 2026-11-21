const SUPPORTED_LOCALES = ["en", "ta", "hi", "te", "ml", "kn", "bn", "es", "fr", "de"];

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function urlEntry(location, lastmod, alternates) {
  const alternateLinks = alternates.map(({ language, url }) => (
    `    <xhtml:link rel="alternate" hreflang="${language}" href="${xmlEscape(url)}" />`
  )).join("\n");
  return [
    "  <url>",
    `    <loc>${xmlEscape(location)}</loc>`,
    `    <lastmod>${xmlEscape(lastmod)}</lastmod>`,
    alternateLinks,
    "  </url>",
  ].join("\n");
}

function pageUrl(origin, language, articleId) {
  return `${origin}/${language}/story/${articleId}`;
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  if (!env.TRANSLATION_DB) {
    return new Response("Translation storage is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const origin = new URL(request.url).origin;
    const homeAlternates = SUPPORTED_LOCALES.map((language) => ({
      language,
      url: `${origin}/${language}/`,
    }));
    homeAlternates.push({ language: "x-default", url: `${origin}/en/` });
    const entries = SUPPORTED_LOCALES.map((language) => (
      urlEntry(`${origin}/${language}/`, new Date().toISOString().slice(0, 10), homeAlternates)
    ));

    const result = await env.TRANSLATION_DB.prepare(
      `SELECT a.article_id, a.updated_at, t.language
       FROM news_articles AS a
       LEFT JOIN news_translations AS t
         ON t.article_id = a.article_id
        AND t.content_version = a.content_version
       ORDER BY a.article_id, t.language`,
    ).all();
    const stories = new Map();
    for (const row of result.results || []) {
      if (!/^[a-f0-9]{64}$/.test(row.article_id)) continue;
      const story = stories.get(row.article_id) || { lastmod: row.updated_at, languages: new Set(["en"]) };
      if (row.language && SUPPORTED_LOCALES.includes(row.language)) story.languages.add(row.language);
      if (row.updated_at > story.lastmod) story.lastmod = row.updated_at;
      stories.set(row.article_id, story);
    }

    for (const [articleId, story] of stories) {
      const alternates = [...story.languages]
        .sort()
        .map((language) => ({ language, url: pageUrl(origin, language, articleId) }));
      alternates.push({ language: "x-default", url: pageUrl(origin, "en", articleId) });
      for (const language of story.languages) {
        entries.push(urlEntry(
          pageUrl(origin, language, articleId),
          (story.lastmod || "").slice(0, 10),
          alternates,
        ));
      }
    }

    const body = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
      ...entries,
      "</urlset>",
      "",
    ].join("\n");
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Content-Type": "application/xml; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Could not build the translation sitemap:", error);
    return new Response("Sitemap is temporarily unavailable.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
