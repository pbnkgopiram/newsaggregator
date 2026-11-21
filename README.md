# Good things to know today

Good things to know today is a source-linked reading brief. It refreshes a set of public RSS and Atom feeds, keeps headlines and short excerpts in a static JSON file, and sends readers to the original publisher for the full story.

It uses Python's standard library and static HTML/CSS/JavaScript. There are no paid APIs, API keys, build services, or server runtime requirements.

## Run locally

You need Python 3.10 or newer. From the project root:

```powershell
python -m unittest discover -s tests -v
python scripts/fetch_feeds.py
python -m http.server 8000
```

Open `http://localhost:8000`. The feed refresh needs outbound internet access. If a feed is unavailable, the collector records the failure and continues with the remaining feeds.

## Configure sources

Edit `sources.json`. Each entry has a display name, an RSS/Atom URL, and a category:

```json
{
  "name": "Example publication",
  "url": "https://example.com/feed.xml",
  "category": "Science"
}
```

Use feeds published by the source itself, check its terms and reuse policy, and keep the source attribution intact. Good things to know today only displays a title and a short excerpt; readers follow a link to read the full article at its original home. Do not remove paywalls, republish full articles, or assume a feed grants permission to reuse copyrighted images or text. If a publisher asks you to stop using its feed, remove it.

During each feed refresh, the collector conservatively groups only cross-publisher entries with strong headline overlap, the same category, and publication times within 48 hours. A grouped card keeps the newest headline, shows the lead feed excerpt, labels any additional feed excerpts by source, and links to every original report. The generated digest retains the raw entries as well as grouped briefings. This is attribution-preserving aggregation, not independent original reporting; add human-written analysis for genuinely original editorial content.

The collector limits each response to 2 MB, each source to 24 entries, each excerpt to 360 characters, and the full digest to 160 entries. It only accepts HTTP(S) story links.

## Search engine discovery

Each live Pages hostname publishes its own canonical URL, `robots.txt`, and `sitemap.xml`. The homepage metadata and structured data describe the site's English-language global news and research brief. To request indexing:

1. Sign in to [Google Search Console](https://search.google.com/search-console/) and add a **URL prefix** property for the hostname you want to monitor.
2. Verify ownership for that property. `google622a2fa14a1f2982.html` is deployed at the root of both sites and must remain there. If Search Console supplies a different verification token for the second hostname, add that file to both deployment bundles and the workflow.
3. Submit that hostname's `/sitemap.xml` in Search Console and use **URL inspection** to request indexing of the homepage and locale routes.
4. Add the hostname to [Bing Webmaster Tools](https://www.bing.com/webmasters/) and submit the same sitemap.

The deployment pre-renders up to 12 source-linked story cards into the homepage HTML. JavaScript then loads the full digest and enables search and filters; if that request fails, the pre-rendered stories remain available.

The deployment publishes `/en/`, `/ta/`, `/hi/`, `/te/`, `/ml/`, `/kn/`, `/bn/`, `/es/`, `/fr/`, and `/de/`. Each route has localized page text and metadata, a self-referencing canonical, and alternate-language links. `/` remains a language-aware entry point: it uses the saved language cookie when present, otherwise the browser's first supported language, and defaults to English. The sitemap lists all locale routes. The build pre-renders source-linked stories into each route so the initial page has crawlable content; client-side translation replaces only story headlines and short summaries when available. Original source names, links, and attribution are retained. Indexing and rankings are not immediate or guaranteed. Search engines may take days or longer to crawl a new site. A feed aggregator should add original summaries, analysis, or other editorial value; simply republishing headlines and excerpts may not rank well and can be insufficient for monetization approval.

## Configure multilingual translations

The UI dictionaries live in `locales.json`. News headlines and short summaries are translated on demand by the Cloudflare Pages Function at `/api/translate`; full third-party articles are never sent for translation. The function uses a configurable OpenAI-compatible chat-completions endpoint, and stores results in D1 keyed by article ID, language, and a SHA-256 content version. Translation failures leave the original English text in place and show a notice. The default quota is 100 uncached translation attempts per IP address per UTC day; cached results do not count.

Before enabling translations on either Pages project:

1. Apply `translation-schema.sql` to the existing `newsaggregator-views` D1 database with `npx wrangler d1 execute newsaggregator-views --remote --file=translation-schema.sql`.
2. In **Workers & Pages → each Pages project → Settings → Bindings**, add a D1 binding named `TRANSLATION_DB` and select `newsaggregator-views`. Bind the same database to both Pages projects so the translation cache and quotas are shared, then redeploy.
3. In each Pages project's production environment, configure `AI_TRANSLATION_ENDPOINT` (an HTTPS OpenAI-compatible chat-completions URL), `AI_TRANSLATION_MODEL`, and the secret `AI_TRANSLATION_API_KEY`. Optionally set `TRANSLATION_DAILY_ITEM_QUOTA`; if omitted, the function uses 100.
4. Push the workflow changes to `main` or run **Refresh and deploy Good things to know today** from GitHub Actions. The deployment bundles contain only the translation Function; they do not include other local, untracked Pages Functions.

Keep the API key only in Cloudflare's server-side secret settings, never in `site-config.js`, `locales.json`, or other public assets. The route-level API limit is 12 stories per request and the daily quota prevents repeat uncached calls from using unlimited provider credits.

## Configure donations

Edit `site-config.js` before deployment. For UPI, set your public UPI ID and payee name; the site creates a standard UPI payment link that opens a compatible app on phones. A phone number by itself is not a reliable web payment address, and publishing it exposes your number. Prefer a UPI ID or a hosted HTTPS payment page. The donation setting is public website content, so only put a payment address you intend visitors to see there. Payment providers may charge transaction fees.

The file starts with empty values:

```js
window.GOODTHINGS_CONFIG = {
  donationUrl: "",
  upiId: "",
  payeeName: "",
  razorpayKeyId: ""
};
```

Fill `upiId` and `payeeName` for UPI, or set `donationUrl` to an HTTPS checkout page. The button remains hidden while both destinations are empty.

For a hosted payment page, set `donationUrl` to its HTTPS URL and leave `upiId` empty. The donation button stays hidden until a valid destination is configured.

## Support page and Razorpay donations

The site now includes a `/support/` page for one-time contributions. The page collects an amount, optional name/email, and opens Razorpay Checkout after the browser calls the Cloudflare Pages Function `/api/support/create-order`.

The backend verifies the payment signature through `/api/support/verify` before redirecting to a success page. This keeps the secret key off client-side assets and prevents a fake client-side success from unlocking anything.

Set the following environment variables in Cloudflare Pages or a local `.env` file before testing:

```bash
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

The repository includes `.env.example` with the required placeholders.

## Page-view counter

The header displays persistent total page views and today's views in UTC. The counter uses the `newsaggregator-counter` Cloudflare Worker and the `newsaggregator-views` D1 database. Each page load increments the figures; these are page views, not unique people. Cloudflare's Workers Free plan currently includes D1 usage suitable for a small counter, subject to daily quotas.

## Publish for free with Cloudflare Pages

The sites are live at <https://goodthingstoknowtoday.pages.dev> and <https://newsaggregator-gopi.pages.dev>. Each deployment has its own canonical URL, sitemap, and robots directive. The previous <https://fieldnotes-erg.pages.dev> deployment also remains active as a backup.

The project is in the public GitHub repository [pbnkgopiram/newsaggregator](https://github.com/pbnkgopiram/newsaggregator). GitHub Actions refreshes the RSS feeds every six hours, then deploys updated assets to both Pages projects.

The workflow requires the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. They are configured in **Settings → Secrets and variables → Actions**. The API token needs **Cloudflare Pages: Edit** access on the account containing both Pages projects. Keep the token private and never put it in project files. Scheduled runs can be delayed by GitHub during busy periods.

The feed collector groups only cross-publisher headlines with strong title overlap, matching category, and publication times within 48 hours. It preserves every publisher link and excerpt. If no stories meet those strict criteria, the site displays individual briefings rather than merging unrelated coverage. Grouped source excerpts are attributed reporting, not original independent reporting.

Cloudflare Pages and GitHub Actions can both be used without charge within their current free-tier quotas. A custom domain and domain registration may cost money. Free service policies and quotas can change, so check the current terms before relying on them for a business.

## Earning revenue

Publishing a site does not automatically produce income. Advertising networks such as AdSense review sites and may require original editorial value, privacy disclosures, policy compliance, and sufficient content before approving ads. Affiliate programs also require separate approval and clear disclosures near qualifying links. Add any required privacy, cookie, advertising, and affiliate disclosures before monetizing. Revenue is not guaranteed, and meaningful earnings usually require sustained readership and ongoing editorial work.

Do not present aggregated headlines as your own reporting. Keep source names and links visible, verify feed licensing and attribution terms, and curate the site with original commentary or useful context rather than relying solely on copied snippets.