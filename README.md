# News Aggregator

News Aggregator is a source-linked reading brief. It refreshes a set of public RSS and Atom feeds, keeps headlines and short excerpts in a static JSON file, and sends readers to the original publisher for the full story.

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

Use feeds published by the source itself, check its terms and reuse policy, and keep the source attribution intact. News Aggregator only displays a title and a short excerpt; readers follow a link to read the full article at its original home. Do not remove paywalls, republish full articles, or assume a feed grants permission to reuse copyrighted images or text. If a publisher asks you to stop using its feed, remove it.

The collector limits each response to 2 MB, each source to 24 entries, each excerpt to 360 characters, and the full digest to 160 entries. It only accepts HTTP(S) story links.

## Google Search

The site now publishes a canonical URL, `robots.txt`, and `sitemap.xml` at the live Pages hostname. To ask Google to crawl it:

1. Sign in to [Google Search Console](https://search.google.com/search-console/) and add a **URL prefix** property for `https://newsaggregator-gopi.pages.dev/`.
2. Verify ownership using the HTML-file method. The provided file `google622a2fa14a1f2982.html` is deployed at the site root and must remain there after verification. Open `https://newsaggregator-gopi.pages.dev/google622a2fa14a1f2982.html` to confirm it is reachable, then click **Verify** in Search Console.
3. In Search Console, open **Sitemaps**, submit `https://newsaggregator-gopi.pages.dev/sitemap.xml`, and use **URL inspection** to request indexing of the homepage.

Indexing and rankings are not immediate or guaranteed. Search engines may take days or longer to crawl a new site. A feed aggregator should add original summaries, analysis, or other editorial value; simply republishing headlines and excerpts may not rank well and can be insufficient for monetization approval.

## Configure donations

Edit `site-config.js` before deployment. For UPI, set your public UPI ID and payee name; the site creates a standard UPI payment link that opens a compatible app on phones. A phone number by itself is not a reliable web payment address, and publishing it exposes your number. Prefer a UPI ID or a hosted HTTPS payment page. The donation setting is public website content, so only put a payment address you intend visitors to see there. Payment providers may charge transaction fees.

The file starts with empty values:

```js
window.FIELDNOTES_CONFIG = {
  donationUrl: "",
  upiId: "",
  payeeName: ""
};
```

Fill `upiId` and `payeeName` for UPI, or set `donationUrl` to an HTTPS checkout page. The button remains hidden while both destinations are empty.

For a hosted payment page, set `donationUrl` to its HTTPS URL and leave `upiId` empty. The donation button stays hidden until a valid destination is configured.

## Page-view counter

The header displays persistent total page views and today's views in UTC. The counter uses the `newsaggregator-counter` Cloudflare Worker and the `newsaggregator-views` D1 database. Each page load increments the figures; these are page views, not unique people. Cloudflare's Workers Free plan currently includes D1 usage suitable for a small counter, subject to daily quotas.

## Publish for free with Cloudflare Pages

The original site remains live at <https://newsaggregator-gopi.pages.dev>. The separate `goodthingstoknowtoday.pages.dev` project is being set up with its own canonical URL and sitemap; deploying it does not replace the original. The previous <https://fieldnotes-erg.pages.dev> deployment also remains active as a backup.

The current Direct Uploads are snapshots of `data/feeds.json`. RSS updates will run automatically every six hours only after this project is pushed to a GitHub repository with Actions enabled. This workspace has not yet been connected to a GitHub repository, so the scheduled workflow is not running yet.

1. Create a public GitHub repository and add these project files to its `main` branch.
2. Create a Cloudflare API token for the account containing the two Pages projects, with **Cloudflare Pages: Edit** permission. Find that Pages account ID in the Cloudflare dashboard. The page-view counter Worker lives in a separate Cloudflare account and does not need to be redeployed for RSS refreshes.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add repository secrets named `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with those values. Keep the token private and never put it in project files.
4. Open **Actions → Refresh and deploy News Aggregator**, choose **Run workflow**, and wait for deployment. The workflow refreshes feeds and publishes hostname-specific static assets to both Pages projects.
5. After setup, the workflow deploys on pushes to `main` and refreshes on a six-hour schedule. Scheduled jobs may be delayed during busy periods. The Cloudflare free plan currently allows up to 500 Pages builds per month, which is within this schedule's typical usage.

Cloudflare Pages and GitHub Actions can both be used without charge within their current free-tier quotas. A custom domain and domain registration may cost money. Free service policies and quotas can change, so check the current terms before relying on them for a business.

## Earning revenue

Publishing a site does not automatically produce income. Advertising networks such as AdSense review sites and may require original editorial value, privacy disclosures, policy compliance, and sufficient content before approving ads. Affiliate programs also require separate approval and clear disclosures near qualifying links. Add any required privacy, cookie, advertising, and affiliate disclosures before monetizing. Revenue is not guaranteed, and meaningful earnings usually require sustained readership and ongoing editorial work.

Do not present aggregated headlines as your own reporting. Keep source names and links visible, verify feed licensing and attribution terms, and curate the site with original commentary or useful context rather than relying solely on copied snippets.