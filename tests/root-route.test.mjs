import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../functions/index.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function request(headers = {}, method = "GET") {
  return new Request("https://site.example/?campaign=world", { method, headers });
}

test("the root route selects the best supported browser language and preserves query parameters", async () => {
  const response = await onRequest({
    request: request({ "Accept-Language": "ja, es;q=0.9, fr;q=0.8" }),
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://site.example/es/?campaign=world");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("a saved language preference overrides browser language", async () => {
  const response = await onRequest({
    request: request({
      Cookie: "theme=light; news-aggregator-language=ta",
      "Accept-Language": "de, fr;q=0.8",
    }),
  });
  assert.equal(response.headers.get("Location"), "https://site.example/ta/?campaign=world");
});

test("unsupported language headers fall back to English and non-read methods are rejected", async () => {
  const fallback = await onRequest({ request: request({ "Accept-Language": "ja, zh;q=0.8" }) });
  assert.equal(fallback.headers.get("Location"), "https://site.example/en/?campaign=world");

  const rejected = await onRequest({ request: request({}, "POST") });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("Allow"), "GET, HEAD");
});
