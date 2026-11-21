const MAX_ITEMS_PER_REQUEST = 12;
const MAX_TEXT_CHARACTERS = 20000;
const MAX_DATABASE_BATCH = 90;
const DEFAULT_DAILY_ITEM_QUOTA = 100;
const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validHttpUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeSources(value, story) {
  const sources = Array.isArray(value) ? value : [];
  return sources
    .filter((source) => source && validHttpUrl(source.url))
    .map((source) => ({
      source: String(source.source || source.name || "").slice(0, 200),
      url: source.url,
      title: String(source.title || story.title).slice(0, 500),
      excerpt: String(source.excerpt || "").slice(0, 1600),
    }));
}

function feedStories(feed) {
  if (Array.isArray(feed.groups)) return feed.groups;
  if (!Array.isArray(feed.entries)) return [];
  return feed.entries.map((entry) => ({
    ...entry,
    summary: entry.excerpt || "",
    sources: [{ source: entry.source || "", url: entry.url, title: entry.title, excerpt: entry.excerpt || "" }],
  }));
}

async function normalizeArticles(feed) {
  const articles = [];
  for (const story of feedStories(feed)) {
    if (!story || typeof story.title !== "string") continue;
    const title = story.title.trim();
    const summary = typeof story.summary === "string" ? story.summary.trim() : "";
    const sourceList = normalizeSources(story.sources, story);
    const url = validHttpUrl(story.url) ? story.url : sourceList[0]?.url;
    if (!title || title.length > 500 || summary.length > 1600 || !url || !sourceList.length) continue;

    const storyKey = typeof story.id === "string" && story.id.trim() ? story.id.trim() : url;
    const articleId = await sha256(`${storyKey}\n${url}`);
    const contentVersion = await sha256(`${title}\n${summary}`);
    articles.push({
      articleId,
      storyKey,
      contentVersion,
      title,
      summary,
      url,
      category: typeof story.category === "string" ? story.category.slice(0, 100) : "General",
      publishedAt: typeof story.publishedAt === "string" ? story.publishedAt.slice(0, 40) : "",
      sourcesJson: JSON.stringify(sourceList),
    });
  }
  return articles;
}

function dailyQuota(env) {
  const raw = env.TRANSLATION_DAILY_ITEM_QUOTA;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_DAILY_ITEM_QUOTA;
  const quota = Number(raw);
  if (!Number.isInteger(quota) || quota < 1 || quota > 10000) {
    throw new Error("Translation daily item quota must be an integer between 1 and 10000.");
  }
  return quota;
}

function translationBatches(items) {
  const batches = [];
  let batch = [];
  let totalCharacters = 0;
  for (const item of items) {
    const itemCharacters = item.title.length + item.summary.length;
    if (batch.length && (batch.length >= MAX_ITEMS_PER_REQUEST || totalCharacters + itemCharacters > MAX_TEXT_CHARACTERS)) {
      batches.push(batch);
      batch = [];
      totalCharacters = 0;
    }
    batch.push(item);
    totalCharacters += itemCharacters;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function translateText(ai, text, language) {
  const result = await ai.run(TRANSLATION_MODEL, {
    text,
    source_lang: "en",
    target_lang: language,
  });
  if (typeof result?.translated_text !== "string") {
    throw new Error("Cloudflare Workers AI returned invalid translation content.");
  }
  return result.translated_text.trim();
}

async function translateBatch(ai, language, items) {
  const translated = await Promise.all(items.map(async (item) => ({
    articleId: item.articleId,
    title: await translateText(ai, item.title, language),
    summary: item.summary ? await translateText(ai, item.summary, language) : "",
  })));
  return new Map(translated.map((item) => [
    item.articleId,
    { title: item.title, summary: item.summary },
  ]));
}

async function storeArticles(database, articles) {
  for (let offset = 0; offset < articles.length; offset += MAX_DATABASE_BATCH) {
    const statements = articles.slice(offset, offset + MAX_DATABASE_BATCH).map((article) => database.prepare(
      `INSERT INTO news_articles
        (article_id, story_key, content_version, title, summary, url, category, published_at, sources_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(article_id) DO UPDATE SET
        story_key = excluded.story_key,
        content_version = excluded.content_version,
        title = excluded.title,
        summary = excluded.summary,
        url = excluded.url,
        category = excluded.category,
        published_at = excluded.published_at,
        sources_json = excluded.sources_json,
        updated_at = CASE
          WHEN news_articles.content_version != excluded.content_version
            OR news_articles.category != excluded.category
            OR news_articles.published_at != excluded.published_at
            OR news_articles.sources_json != excluded.sources_json
          THEN excluded.updated_at
          ELSE news_articles.updated_at
        END`,
    ).bind(
      article.articleId,
      article.storyKey,
      article.contentVersion,
      article.title,
      article.summary,
      article.url,
      article.category,
      article.publishedAt,
      article.sourcesJson,
      new Date().toISOString(),
    ));
    await database.batch(statements);
  }
}

async function findExistingTranslations(database, language, articles) {
  const articleIds = articles.map((article) => article.articleId);
  if (!articleIds.length) return new Set();
  const placeholders = articleIds.map(() => "?").join(", ");
  const result = await database.prepare(
    `SELECT t.article_id, t.content_version FROM news_translations AS t
     JOIN news_articles AS a
       ON a.article_id = t.article_id
      AND a.content_version = t.content_version
     WHERE t.language = ? AND t.article_id IN (${placeholders})`,
  ).bind(language, ...articleIds).all();
  const versions = new Map((result.results || []).map((row) => [row.article_id, row.content_version]));
  return new Set(articles
    .filter((article) => versions.get(article.articleId) === article.contentVersion)
    .map((article) => article.articleId));
}

async function reserveDailyQuota(database, dayUtc, amount, quota) {
  return database.prepare(
    `INSERT INTO translation_index_daily_usage (day_utc, translated_items)
     VALUES (?, ?)
     ON CONFLICT(day_utc) DO UPDATE SET
       translated_items = translated_items + excluded.translated_items
     WHERE translation_index_daily_usage.translated_items + excluded.translated_items <= ?
     RETURNING translated_items`,
  ).bind(dayUtc, amount, quota).first();
}

async function dailyUsage(database, dayUtc) {
  const row = await database.prepare(
    "SELECT translated_items FROM translation_index_daily_usage WHERE day_utc = ?",
  ).bind(dayUtc).first();
  return row?.translated_items || 0;
}

async function refreshTranslations(env) {
  if (!env.TRANSLATION_DB) throw new Error("Translation indexer D1 binding is missing.");
  if (!env.AI) throw new Error("Translation indexer Workers AI binding is missing.");
  const quota = dailyQuota(env);
  const feedUrl = typeof env.FEED_DATA_URL === "string" ? env.FEED_DATA_URL : "";
  const localeUrl = typeof env.LOCALE_CATALOG_URL === "string" ? env.LOCALE_CATALOG_URL : "";
  if (!feedUrl || !localeUrl) throw new Error("Translation indexer feed URLs are missing.");

  const freshFeedUrl = new URL(feedUrl);
  freshFeedUrl.searchParams.set("_index", String(Date.now()));
  const [feedResponse, localeResponse] = await Promise.all([
    fetch(freshFeedUrl, { cache: "no-store" }),
    fetch(localeUrl, { cache: "no-store" }),
  ]);
  if (!feedResponse.ok || !localeResponse.ok) throw new Error("Translation indexer could not load its inputs.");
  const [feed, catalog] = await Promise.all([feedResponse.json(), localeResponse.json()]);
  if (!catalog?.languages || typeof catalog.languages !== "object") {
    throw new Error("Translation indexer locale catalog is invalid.");
  }

  const articles = await normalizeArticles(feed);
  if (!articles.length) throw new Error("Translation indexer received no valid source-linked stories.");
  await storeArticles(env.TRANSLATION_DB, articles);

  const dayUtc = new Date().toISOString().slice(0, 10);
  let remaining = Math.max(0, quota - await dailyUsage(env.TRANSLATION_DB, dayUtc));
  let translated = 0;
  for (const language of Object.keys(catalog.languages)) {
    if (language === "en") continue;
    if (!/^[a-z]{2}$/.test(language)) {
      throw new Error(`Translation catalog has invalid language code ${language}.`);
    }
    const existing = await findExistingTranslations(env.TRANSLATION_DB, language, articles);
    const misses = articles.filter((article) => !existing.has(article.articleId));
    for (const batch of translationBatches(misses)) {
      if (remaining <= 0) break;
      const selected = batch.slice(0, remaining);
      const reservation = await reserveDailyQuota(env.TRANSLATION_DB, dayUtc, selected.length, quota);
      if (!reservation) {
        remaining = 0;
        break;
      }

      const translatedBatch = await translateBatch(env.AI, language, selected);
      const writes = selected.map((article) => {
        const translation = translatedBatch.get(article.articleId);
        return env.TRANSLATION_DB.prepare(
          `INSERT INTO news_translations
            (article_id, language, content_version, translated_title, translated_summary)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(article_id, language, content_version) DO NOTHING`,
        ).bind(
          article.articleId,
          language,
          article.contentVersion,
          translation.title,
          translation.summary,
        );
      });
      await env.TRANSLATION_DB.batch(writes);
      translated += selected.length;
      remaining -= selected.length;
    }
    if (remaining <= 0) break;
  }

  console.log(`Translation index refreshed: ${articles.length} stories indexed, ${translated} translations added.`);
  return { articles: articles.length, translated };
}

export default {
  async scheduled(_controller, env) {
    try {
      await refreshTranslations(env);
    } catch (error) {
      console.error("Scheduled translation indexing failed:", error);
      throw error;
    }
  },
};

export { refreshTranslations };
