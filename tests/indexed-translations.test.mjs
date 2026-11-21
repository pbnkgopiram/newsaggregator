import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/api/translations.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

class FakeDatabase {
  constructor(rows = []) {
    this.rows = rows;
  }

  prepare(sql) {
    const database = this;
    return {
      values: [],
      bind(...values) {
        this.values = values;
        return this;
      },
      async all() {
        if (sql.includes("FROM news_articles") && !sql.includes("JOIN news_translations")) {
          return { results: database.rows.english || [] };
        }
        if (sql.includes("JOIN news_translations")) {
          return { results: database.rows.translated || [] };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    };
  }
}

function request(method = "GET", language = "ta") {
  return new Request(`https://site.example/api/translations?language=${language}`, { method });
}

test("the translations endpoint reads stored localized rows without a provider call", async () => {
  const database = new FakeDatabase({
    translated: [{ article_id: "a".repeat(64), story_key: "article-1", title: "தலைப்பு", summary: "சுருக்கம்" }],
  });
  const response = await onRequest({
    request: request(),
    env: { TRANSLATION_DB: database },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /max-age=300/);
  assert.deepEqual((await response.json()).articles, database.rows.translated);
});

test("English requests return indexed original story data", async () => {
  const database = new FakeDatabase({
    english: [{ article_id: "b".repeat(64), story_key: "article-2", title: "Original title", summary: "Original excerpt" }],
  });
  const response = await onRequest({
    request: request("GET", "en"),
    env: { TRANSLATION_DB: database },
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).articles, database.rows.english);
});

test("unsupported languages and methods are rejected", async () => {
  const database = new FakeDatabase();
  const unsupported = await onRequest({ request: request("GET", "xx"), env: { TRANSLATION_DB: database } });
  assert.equal(unsupported.status, 400);

  const method = await onRequest({ request: request("POST"), env: { TRANSLATION_DB: database } });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "GET");
});

test("localized story pages render from D1 with source links and canonical metadata", async () => {
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  const pageSource = await readFile(new URL("../functions/[locale]/story/[id].js", import.meta.url), "utf8");
  const { onRequest: renderStory } = await import(`data:text/javascript;base64,${Buffer.from(pageSource).toString("base64")}`);
  const articleId = "c".repeat(64);
  const database = {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM news_articles")) {
            return {
              article_id: articleId,
              title: "Original headline",
              summary: "Original summary",
              url: "https://publisher.example/story",
              category: "World",
              published_at: "2026-11-21T10:00:00Z",
              sources_json: JSON.stringify([{ source: "Publisher", url: "https://publisher.example/story" }]),
              content_version: "version-1",
            };
          }
          if (sql.includes("FROM news_translations")) {
            return { translated_title: "தலைப்பு", translated_summary: "சுருக்கம்" };
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          return { results: [{ language: "ta" }] };
        },
      };
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    languages: { ta: { name: "தமிழ்" } },
    messages: { ta: { categories: { World: "உலகம்" }, homeLabel: "முகப்பு", sourceLabel: "ஆதாரம்:", originalSource: "மூலம்" } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const response = await renderStory({
      request: new Request(`https://site.example/ta/story/${articleId}`),
      env: { TRANSLATION_DB: database },
      params: { locale: "ta", id: articleId },
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<html lang="ta">/);
    assert.match(html, /<h1>தலைப்பு<\/h1>/);
    assert.match(html, /https:\/\/publisher\.example\/story/);
    assert.match(html, new RegExp(`<link rel="canonical" href="https://site.example/ta/story/${articleId}">`));
    assert.doesNotMatch(html, /full publisher article/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("story pages do not expose untranslated content under a non-English route", async () => {
  const pageSource = await readFile(new URL("../functions/[locale]/story/[id].js", import.meta.url), "utf8");
  const { onRequest: renderStory } = await import(`data:text/javascript;base64,${Buffer.from(pageSource).toString("base64")}`);
  const articleId = "d".repeat(64);
  const database = {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes("FROM news_articles")) {
            return {
              article_id: articleId,
              title: "Original headline",
              summary: "Original summary",
              url: "https://publisher.example/story",
              category: "World",
              published_at: "",
              sources_json: "[]",
              content_version: "version-1",
            };
          }
          return null;
        },
      };
    },
  };
  const response = await renderStory({
    request: new Request(`https://site.example/ta/story/${articleId}`),
    env: { TRANSLATION_DB: database },
    params: { locale: "ta", id: articleId },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
});
