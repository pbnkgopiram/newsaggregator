const SUPPORTED_LOCALES = new Set(["en", "ta", "hi", "te", "ml", "kn", "bn", "es", "fr", "de"]);
const LANGUAGE_COOKIE = "news-aggregator-language";

function savedLocale(cookieHeader) {
  for (const part of (cookieHeader || "").split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== LANGUAGE_COOKIE) continue;
    const value = valueParts.join("=");
    return SUPPORTED_LOCALES.has(value) ? value : null;
  }
  return null;
}

function browserLocale(header) {
  const preferences = (header || "")
    .split(",")
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/i)?.[1])
        .find(Boolean);
      return {
        locale: tag.toLowerCase().split("-")[0],
        quality: quality === undefined ? 1 : Number(quality),
        order: index,
      };
    })
    .filter((preference) => preference.quality > 0 && SUPPORTED_LOCALES.has(preference.locale))
    .sort((left, right) => right.quality - left.quality || left.order - right.order);
  return preferences[0]?.locale || "en";
}

export function onRequest({ request }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }

  const locale = savedLocale(request.headers.get("Cookie")) || browserLocale(request.headers.get("Accept-Language"));
  const destination = new URL(request.url);
  destination.pathname = `/${locale}/`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.href,
      "Cache-Control": "no-store",
      "Vary": "Accept-Language, Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
