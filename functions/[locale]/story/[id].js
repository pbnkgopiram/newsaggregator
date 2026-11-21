const SUPPORTED_LOCALES = new Set(["en", "ta", "hi", "te", "ml", "kn", "bn", "es", "fr", "de"]);

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function response(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...headers,
    },
  });
}

function notFound() {
  return response("<!doctype html><title>Story not found</title>", 404, {
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
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

function pageHtml({ origin, locale, article, title, summary, sources, messages, alternates }) {
  const canonical = `${origin}/${locale}/story/${article.article_id}`;
  const category = messages.categories?.[article.category] || article.category || "News";
  const sourceLinks = sources.map((source) => {
    const sourceName = source.source || messages.originalSource || "Original source";
    return `<li><a href="${htmlEscape(source.url)}" target="_blank" rel="noopener noreferrer">${htmlEscape(sourceName)} ↗</a></li>`;
  }).join("\n");
  const alternateTags = alternates.map(({ language, url }) => (
    `<link rel="alternate" hreflang="${htmlEscape(language)}" href="${htmlEscape(url)}">`
  )).join("\n    ");
  const date = article.published_at ? `<time datetime="${htmlEscape(article.published_at)}">${htmlEscape(article.published_at.slice(0, 10))}</time>` : "";
  const description = summary || title;
  const homeLabel = messages.homeLabel || "Good things to know today home";
  const sourceLabel = messages.sourceLabel || "Source:";

  return `<!doctype html>
<html lang="${htmlEscape(locale)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="${htmlEscape(description)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Good things to know today">
    <meta property="og:title" content="${htmlEscape(title)}">
    <meta property="og:description" content="${htmlEscape(description)}">
    <meta property="og:url" content="${htmlEscape(canonical)}">
    <link rel="canonical" href="${htmlEscape(canonical)}">
    ${alternateTags}
    <link rel="alternate" hreflang="x-default" href="${htmlEscape(`${origin}/en/story/${article.article_id}`)}">
    <link rel="stylesheet" href="/styles.css">
    <title>${htmlEscape(title)} | Good things to know today</title>
  </head>
  <body>
    <header class="topbar">
      <a class="wordmark" href="/${htmlEscape(locale)}/" aria-label="${htmlEscape(homeLabel)}"><span class="mark" aria-hidden="true">g.</span> Good things to know today</a>
    </header>
    <main class="story-page">
      <article>
        <p class="eyebrow">${htmlEscape(category)}${date ? ` · ${date}` : ""}</p>
        <h1>${htmlEscape(title)}</h1>
        ${summary ? `<p class="intro-description">${htmlEscape(summary)}</p>` : ""}
        <div class="story-source"><span>${htmlEscape(sourceLabel)}</span><ul>${sourceLinks}</ul></div>
      </article>
    </main>
    <footer class="footer"><a class="footer-mark" href="/${htmlEscape(locale)}/">Good things to know today</a></footer>
  </body>
</html>`;
}

export async function onRequest({ request, env, params }) {
  const locale = params.locale;
  const articleId = params.id;
  if (!SUPPORTED_LOCALES.has(locale) || !/^[a-f0-9]{64}$/.test(articleId || "")) return notFound();
  if (!env.TRANSLATION_DB) {
    return response("Translation storage is not configured.", 503, { "Cache-Control": "no-store" });
  }

  try {
    const article = await env.TRANSLATION_DB.prepare(
      `SELECT article_id, title, summary, url, category, published_at, sources_json, content_version
       FROM news_articles
       WHERE article_id = ?`,
    ).bind(articleId).first();
    if (!article) return notFound();

    let title = article.title;
    let summary = article.summary;
    if (locale !== "en") {
      const translation = await env.TRANSLATION_DB.prepare(
        `SELECT translated_title, translated_summary
         FROM news_translations
         WHERE article_id = ? AND language = ? AND content_version = ?`,
      ).bind(articleId, locale, article.content_version).first();
      if (!translation) return notFound();
      title = translation.translated_title;
      summary = translation.translated_summary;
    }

    let sources;
    try {
      sources = JSON.parse(article.sources_json);
    } catch {
      console.error("Indexed article has invalid source data:", articleId);
      return response("Story data is temporarily unavailable.", 503, { "Cache-Control": "no-store" });
    }
    if (!Array.isArray(sources)) {
      console.error("Indexed article has invalid source data:", articleId);
      return response("Story data is temporarily unavailable.", 503, { "Cache-Control": "no-store" });
    }
    sources = sources.filter((source) => source && validArticleUrl(source.url));

    const [availableLocales, catalogResponse] = await Promise.all([
      env.TRANSLATION_DB.prepare(
        `SELECT language FROM news_translations
         WHERE article_id = ? AND content_version = ?`,
      ).bind(articleId, article.content_version).all(),
      fetch(new URL("/locales.json", request.url)),
    ]);
    if (!catalogResponse.ok) throw new Error(`Locale catalog returned ${catalogResponse.status}.`);
    const catalog = await catalogResponse.json();
    const messages = catalog.messages?.[locale];
    if (!messages) throw new Error(`Locale catalog is missing ${locale}.`);

    const alternates = [
      { language: "en", url: `${new URL(request.url).origin}/en/story/${articleId}` },
      ...(availableLocales.results || [])
        .map((row) => row.language)
        .filter((language) => SUPPORTED_LOCALES.has(language))
        .map((language) => ({
          language,
          url: `${new URL(request.url).origin}/${language}/story/${articleId}`,
        })),
    ].filter((alternate, index, list) => list.findIndex((item) => item.language === alternate.language) === index);
    return response(pageHtml({
      origin: new URL(request.url).origin,
      locale,
      article,
      title,
      summary,
      sources,
      messages,
      alternates,
    }), 200, {
      "Cache-Control": "public, max-age=300, s-maxage=300",
    });
  } catch (error) {
    console.error("Could not render indexed story:", error);
    return response("Story is temporarily unavailable.", 503, { "Cache-Control": "no-store" });
  }
}
