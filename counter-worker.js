const ALLOWED_ORIGINS = new Set([
  "https://newsaggregator-gopi.pages.dev",
  "https://goodthingstoknowtoday.pages.dev",
  "https://fieldnotes-erg.pages.dev"
]);

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Vary": "Origin"
    }
  });
}

async function readCounts(database, today) {
  const [total, daily] = await Promise.all([
    database.prepare("SELECT views FROM page_totals WHERE counter = 'all'").first(),
    database.prepare("SELECT views FROM daily_views WHERE day = ?").bind(today).first()
  ]);
  return { total: total?.views ?? 0, today: daily?.views ?? 0 };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (!ALLOWED_ORIGINS.has(origin)) {
      return Response.json({ error: "Origin not allowed" }, { status: 403 });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin);
    }

    const today = new Date().toISOString().slice(0, 10);
    try {
      await env.COUNTER_DB.batch([
        env.COUNTER_DB.prepare("INSERT INTO page_totals (counter, views) VALUES ('all', 1) ON CONFLICT(counter) DO UPDATE SET views = views + 1"),
        env.COUNTER_DB.prepare("INSERT INTO daily_views (day, views) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET views = views + 1").bind(today)
      ]);
      return jsonResponse(await readCounts(env.COUNTER_DB, today), 200, origin);
    } catch (error) {
      console.error("Page-view counter failed:", error);
      return jsonResponse({ error: "Counter unavailable" }, 503, origin);
    }
  }
};