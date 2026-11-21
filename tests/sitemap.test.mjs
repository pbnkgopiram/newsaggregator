import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/sitemap.xml.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function database(rows) {
  return {
    prepare() {
      return {
        async all() {
          return { results: rows };
        },
      };
    },
  };
}

test("the dynamic sitemap includes locale homepages and only indexed story-language routes", async () => {
  const articleId = "e".repeat(64);
  const response = await onRequest({
    request: new Request("https://site.example/sitemap.xml"),
    env: {
      TRANSLATION_DB: database([
        { article_id: articleId, updated_at: "2026-11-21T10:00:00Z", language: null },
        { article_id: articleId, updated_at: "2026-11-21T10:00:00Z", language: "ta" },
        { article_id: articleId, updated_at: "2026-11-21T10:00:00Z", language: "fr" },
        { article_id: "bad-id", updated_at: "2026-11-21T10:00:00Z", language: "ta" },
      ]),
    },
  });
  const xml = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/xml; charset=utf-8");
  assert.match(xml, /https:\/\/site\.example\/ta\//);
  assert.match(xml, new RegExp(`https://site\\.example/ta/story/${articleId}`));
  assert.match(xml, new RegExp(`https://site\\.example/fr/story/${articleId}`));
  assert.match(xml, new RegExp(`https://site\\.example/en/story/${articleId}`));
  assert.doesNotMatch(xml, /bad-id/);
  assert.match(xml, /hreflang="x-default"/);
});

test("the dynamic sitemap requires the D1 binding and supports HEAD", async () => {
  const unavailable = await onRequest({
    request: new Request("https://site.example/sitemap.xml"),
    env: {},
  });
  assert.equal(unavailable.status, 503);

  const head = await onRequest({
    request: new Request("https://site.example/sitemap.xml", { method: "HEAD" }),
    env: { TRANSLATION_DB: database([]) },
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});
