import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const source = await readFile(new URL("../translation-indexer.js", import.meta.url), "utf8");
const { refreshTranslations } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

class FakeStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async first() {
    if (this.sql.includes("SELECT translated_items")) {
      return this.database.usage ? { translated_items: this.database.usage } : null;
    }
    if (this.sql.includes("INSERT INTO translation_index_daily_usage")) {
      const [day, count, quota] = this.values;
      if (this.database.usage + count > quota) return null;
      this.database.usage += count;
      this.database.usageDay = day;
      return { translated_items: this.database.usage };
    }
    throw new Error(`Unexpected first() query: ${this.sql}`);
  }

  async all() {
    if (!this.sql.includes("SELECT t.article_id, t.content_version")) {
      throw new Error(`Unexpected all() query: ${this.sql}`);
    }
    const [language, ...articleIds] = this.values;
    return {
      results: [...this.database.translations.values()]
        .filter((row) => row.language === language && articleIds.includes(row.article_id))
        .filter((row) => this.database.articles.get(row.article_id)?.content_version === row.content_version)
        .map(({ article_id, content_version }) => ({ article_id, content_version })),
    };
  }
}

class FakeDatabase {
  constructor() {
    this.articles = new Map();
    this.translations = new Map();
    this.usage = 0;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) {
      if (statement.sql.includes("INSERT INTO news_articles")) {
        const [article_id, story_key, content_version, title, summary, url, category, published_at, sources_json, updated_at] = statement.values;
        this.articles.set(article_id, { article_id, story_key, content_version, title, summary, url, category, published_at, sources_json, updated_at });
      } else if (statement.sql.includes("INSERT INTO news_translations")) {
        const [article_id, language, content_version, translated_title, translated_summary] = statement.values;
        const key = `${article_id}:${language}:${content_version}`;
        this.translations.set(key, { article_id, language, content_version, translated_title, translated_summary });
      } else {
        throw new Error(`Unexpected batch statement: ${statement.sql}`);
      }
    }
    return [];
  }
}

const feed = {
  groups: [
    { id: "story-1", title: "One headline", summary: "Short summary one", url: "https://publisher.example/1", category: "World", publishedAt: "2026-11-21T10:00:00Z", sources: [{ source: "Publisher", url: "https://publisher.example/1" }] },
    { id: "story-2", title: "Two headline", summary: "Short summary two", url: "https://publisher.example/2", category: "Science", publishedAt: "2026-11-21T09:00:00Z", sources: [{ source: "Publisher", url: "https://publisher.example/2" }] },
  ],
};

const catalog = {
  languages: {
    en: { name: "English" },
    ta: { name: "தமிழ்", providerName: "Tamil" },
  },
};

test("the scheduled indexer stores source records and respects the daily translation cap", async () => {
  const database = new FakeDatabase();
  const originalFetch = globalThis.fetch;
  const translationRequests = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname === "/data/feeds.json") {
      return new Response(JSON.stringify(feed), { status: 200 });
    }
    if (requestUrl.pathname === "/locales.json") {
      return new Response(JSON.stringify(catalog), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  const env = {
    TRANSLATION_DB: database,
    AI: {
      async run(model, input) {
        translationRequests.push({ model, input });
        return { translated_text: `Tamil ${input.text}` };
      },
    },
    TRANSLATION_DAILY_ITEM_QUOTA: "1",
    FEED_DATA_URL: "https://site.example/data/feeds.json",
    LOCALE_CATALOG_URL: "https://site.example/locales.json",
  };

  try {
    const firstRun = await refreshTranslations(env);
    assert.equal(firstRun.articles, 2);
    assert.equal(firstRun.translated, 1);
    assert.equal(database.articles.size, 2);
    assert.equal(database.translations.size, 1);
    assert.equal(database.usage, 1);
    assert.equal(translationRequests.length, 2);
    assert.deepEqual(translationRequests.map(({ model, input }) => [model, input.source_lang, input.target_lang]), [
      ["@cf/meta/m2m100-1.2b", "en", "ta"],
      ["@cf/meta/m2m100-1.2b", "en", "ta"],
    ]);
    assert.deepEqual(translationRequests.map(({ input }) => input.text), [
      "One headline",
      "Short summary one",
    ]);

    const secondRun = await refreshTranslations(env);
    assert.equal(secondRun.translated, 0);
    assert.equal(translationRequests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the indexer requires its Workers AI binding", async () => {
  const env = {
    TRANSLATION_DB: new FakeDatabase(),
    FEED_DATA_URL: "https://site.example/data/feeds.json",
    LOCALE_CATALOG_URL: "https://site.example/locales.json",
  };
  await assert.rejects(refreshTranslations(env), /Workers AI binding is missing/);
});
