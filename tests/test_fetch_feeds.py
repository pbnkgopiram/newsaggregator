import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_feeds
from fetch_feeds import clean_excerpt, parse_feed


class FeedParsingTests(unittest.TestCase):
    def test_parses_rss_and_sanitizes_excerpt(self):
        xml = b"""<rss version='2.0'><channel><item>
          <title>A <b>clear</b> headline</title>
          <link>https://news.example/story</link>
          <description><![CDATA[<p>A useful <em>short</em> summary &amp; context.</p>]]></description>
          <pubDate>Sat, 14 Nov 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>"""
        entries = parse_feed(xml, {"name": "Example", "url": "https://news.example/feed", "category": "News"})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "A clear headline")
        self.assertEqual(entries[0]["excerpt"], "A useful short summary & context.")
        self.assertEqual(entries[0]["category"], "News")
        self.assertTrue(entries[0]["publishedAt"].startswith("2026-11-14T10:00:00"))

    def test_parses_atom_links_and_rejects_non_web_urls(self):
        xml = b"""<feed xmlns='http://www.w3.org/2005/Atom'><entry>
          <title>Research note</title><link href='/notes/1'/><updated>2026-11-14T10:00:00Z</updated>
          <summary>New research.</summary></entry><entry><title>Unsafe</title>
          <link href='javascript:alert(1)'/></entry></feed>"""
        entries = parse_feed(xml, {"name": "Lab", "url": "https://lab.example/feed"})
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["url"], "https://lab.example/notes/1")
        self.assertEqual(entries[0]["excerpt"], "New research.")

    def test_excerpt_has_a_hard_limit(self):
        excerpt = clean_excerpt("<p>" + ("useful words " * 80) + "</p>", 40)
        self.assertLessEqual(len(excerpt), 40)
        self.assertTrue(excerpt.endswith("…"))

    def test_all_sources_failing_preserves_last_good_digest(self):
      with tempfile.TemporaryDirectory() as temporary_directory:
        sources_path = Path(temporary_directory) / "sources.json"
        output_path = Path(temporary_directory) / "feeds.json"
        sources_path.write_text(json.dumps([{"name": "Offline", "url": "https://example.com/feed"}]), encoding="utf-8")
        output_path.write_text("last-good-digest", encoding="utf-8")
        with patch.object(fetch_feeds, "SOURCES_PATH", sources_path), patch.object(fetch_feeds, "OUTPUT_PATH", output_path), patch.object(fetch_feeds, "fetch_source", return_value=([], "offline")):
          self.assertEqual(fetch_feeds.main(), 1)
        self.assertEqual(output_path.read_text(encoding="utf-8"), "last-good-digest")


if __name__ == "__main__":
    unittest.main()