import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/api/translate.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

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
    if (this.sql.includes("SELECT translated_title")) {
      this.database.lookups.push(this.values);
      return this.database.cacheHit
        ? { translated_title: "Cached headline", translated_summary: "Cached summary" }
        : null;
    }
    if (this.sql.includes("translation_daily_usage")) {
      this.database.quotaReservations += 1;
      return this.database.quotaAllows ? { translated_items: this.values[2] } : null;
    }
    throw new Error(`Unexpected first() query: ${this.sql}`);
  }

  async run() {
    this.database.writes.push({ sql: this.sql, values: this.values });
    return { success: true };
  }
}

class FakeDatabase {
  constructor({ cacheHit = false, quotaAllows = true } = {}) {
    this.cacheHit = cacheHit;
    this.quotaAllows = quotaAllows;
    this.lookups = [];
    this.quotaReservations = 0;
    this.writes = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }
}

function request(body, headers = {}) {
  return new Request("https://site.example/api/translate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://site.example",
      "CF-Connecting-IP": "192.0.2.10",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function item(title = "Original headline") {
  return {
    id: "article-1",
    url: "https://news.example/story",
    title,
    summary: "A short source summary.",
  };
}

function providerFetch() {
  return async (_url, options) => {
    const userContent = JSON.parse(options.body).messages[1].content;
    const suppliedItems = JSON.parse(userContent).items;
    const translations = suppliedItems.map((story) => ({
      id: story.id,
      title: `Translated: ${story.title}`,
      summary: `Translated: ${story.summary}`,
    }));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translations }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

const providerEnv = {
  AI_TRANSLATION_ENDPOINT: "https://api.example.test/v1/chat/completions",
  AI_TRANSLATION_API_KEY: "test-secret",
  AI_TRANSLATION_MODEL: "test-model",
  TRANSLATION_DAILY_ITEM_QUOTA: "100",
};

test("cached translations bypass the provider and daily quota", async () => {
  const database = new FakeDatabase({ cacheHit: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Provider must not be called for a cache hit");
  };
  try {
    const response = await onRequest({
      request: request({ language: "ta", items: [item()] }),
      env: { ...providerEnv, TRANSLATION_DB: database },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.translations[0].title, "Cached headline");
    assert.equal(database.quotaReservations, 0);
    assert.equal(database.writes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an exhausted quota prevents a paid provider request", async () => {
  const database = new FakeDatabase({ quotaAllows: false });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await onRequest({
      request: request({ language: "hi", items: [item()] }),
      env: { ...providerEnv, TRANSLATION_DB: database },
    });
    assert.equal(response.status, 429);
    assert.equal(providerCalls, 0);
    assert.equal(database.quotaReservations, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("changed headline content receives a new cache version", async () => {
  const database = new FakeDatabase();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch();
  try {
    for (const title of ["Original headline", "Updated headline"]) {
      const response = await onRequest({
        request: request({ language: "fr", items: [item(title)] }),
        env: { ...providerEnv, TRANSLATION_DB: database },
      });
      assert.equal(response.status, 200);
    }
    assert.equal(database.lookups.length, 2);
    assert.equal(database.lookups[0][0], database.lookups[1][0]);
    assert.equal(database.lookups[0][1], "fr");
    assert.equal(database.lookups[1][1], "fr");
    assert.notEqual(database.lookups[0][2], database.lookups[1][2]);
    assert.equal(database.writes.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid locales and cross-origin requests are rejected", async () => {
  const database = new FakeDatabase();
  const invalidLocale = await onRequest({
    request: request({ language: "xx", items: [item()] }),
    env: { TRANSLATION_DB: database },
  });
  assert.equal(invalidLocale.status, 400);

  const crossOrigin = await onRequest({
    request: request({ language: "ta", items: [item()] }, { Origin: "https://attacker.example" }),
    env: { TRANSLATION_DB: database },
  });
  assert.equal(crossOrigin.status, 403);
});
