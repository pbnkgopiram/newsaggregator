import json
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from scripts.build_locales import build_site
from scripts.prerender import render_page


ROOT = Path(__file__).resolve().parents[1]
SITEMAP_NS = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9", "x": "http://www.w3.org/1999/xhtml"}


class LocaleBuildTests(unittest.TestCase):
    def setUp(self):
        self.catalog = json.loads((ROOT / "locales.json").read_text(encoding="utf-8"))
        self.template = (ROOT / "index.html").read_text(encoding="utf-8")
        self.feed_data = {
            "generatedAt": "2026-11-21T14:50:00Z",
            "groups": [{
                "id": "article-1",
                "title": "Original English headline",
                "url": "https://news.example/story",
                "category": "World",
                "publishedAt": "2026-11-21T12:00:00Z",
                "summary": "A short source-linked summary.",
                "sources": [{"source": "Example News", "url": "https://news.example/story"}],
            }],
        }

    def test_builds_self_canonical_localized_routes_and_hreflang_sitemap(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            site_dir = Path(temporary_directory)
            (site_dir / "index.html").write_text(render_page(self.template, self.feed_data), encoding="utf-8")
            locales_file = site_dir / "locales.json"
            locales_file.write_text(json.dumps(self.catalog, ensure_ascii=False), encoding="utf-8")

            count = build_site(site_dir, "https://news.example", locales_file)

            self.assertEqual(count, 10)
            tamil = (site_dir / "ta" / "index.html").read_text(encoding="utf-8")
            self.assertIn('<html lang="ta">', tamil)
            self.assertIn('<link rel="canonical" href="https://news.example/ta/">', tamil)
            self.assertIn('hreflang="ta" href="https://news.example/ta/"', tamil)
            self.assertIn("உலகம்", tamil)
            self.assertIn("Original English headline", tamil)
            self.assertIn('href="https://news.example/story"', tamil)

            root = (site_dir / "index.html").read_text(encoding="utf-8")
            self.assertIn('<link rel="canonical" href="https://news.example/">', root)
            self.assertIn('window.location.replace("/" + language + "/"', root)
            self.assertIn('href="https://news.example/en/"', root)

            sitemap = ET.parse(site_dir / "sitemap.xml").getroot()
            urls = sitemap.findall("s:url", SITEMAP_NS)
            self.assertEqual(len(urls), 10)
            self.assertEqual(len(urls[0].findall("x:link", SITEMAP_NS)), 11)
            self.assertEqual(urls[0].find("s:loc", SITEMAP_NS).text, "https://news.example/en/")
            for locale in self.catalog["languages"]:
                localized = (site_dir / locale / "index.html").read_text(encoding="utf-8")
                self.assertIn("Good things to know today", localized)
                self.assertNotIn("News Aggregator", localized)
            routes = json.loads((site_dir / "_routes.json").read_text(encoding="utf-8"))
            self.assertEqual(routes, {
                "version": 1,
                "include": [
                    "/",
                    "/api/translations",
                    "/sitemap.xml",
                    *[f"/{locale}/story/*" for locale in self.catalog["languages"]],
                ],
                "exclude": [],
            })

    def test_catalog_has_all_ten_languages_and_consistent_messages(self):
        languages = self.catalog["languages"]
        messages = self.catalog["messages"]
        self.assertEqual(set(languages), {"en", "ta", "hi", "te", "ml", "kn", "bn", "es", "fr", "de"})
        self.assertEqual(set(messages), set(languages))
        english_keys = set(messages["en"])
        for locale, dictionary in messages.items():
            with self.subTest(locale=locale):
                self.assertEqual(set(dictionary), english_keys)
                self.assertEqual(len(dictionary["monthsShort"]), 12)
                self.assertIn("World", dictionary["categories"])
                self.assertIn("storyLinkLabel", dictionary)


if __name__ == "__main__":
    unittest.main()
