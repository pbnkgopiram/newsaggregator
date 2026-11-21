import unittest

from scripts.prerender import render_page


TEMPLATE = """<html>
<div class="story-list" id="story-list" aria-live="polite" aria-busy="true">
<!-- PRERENDERED_STORIES_START -->
<div class="loading-state">Loading</div>
<!-- PRERENDERED_STORIES_END -->
</div>
<span class="story-count" id="story-count">— stories</span>
<span class="category-count" data-count="all">0</span>
<span id="issue-number">01</span>
<span class="stamp-bottom" id="updated-at">UPDATING…</span>
</html>"""


class PrerenderTests(unittest.TestCase):
    def test_renders_source_linked_stories_safely_and_respects_limit(self):
        stories = []
        for index in range(3):
            stories.append({
                "title": f"Story {index}",
                "url": f"https://news.example/story-{index}?a=1&b=2",
                "category": "World",
                "publishedAt": f"2026-11-{21 - index:02d}T12:00:00Z",
                "summary": "<script>alert('x')</script> A useful \\1 summary.",
                "sources": [{"source": "Example & News", "url": f"https://news.example/story-{index}?a=1&b=2"}],
                "additionalCoverage": [{"source": "Other <News>", "excerpt": "Another useful excerpt."}],
            })

        result = render_page(TEMPLATE, {"generatedAt": "2026-11-21T14:50:00Z", "groups": stories}, limit=2)

        self.assertEqual(result.count('<article class="story-card"'), 2)
        self.assertIn("3 stories", result)
        self.assertIn('aria-busy="false"', result)
        self.assertIn('href="https://news.example/story-0?a=1&amp;b=2"', result)
        self.assertIn("&lt;script&gt;alert(&#x27;x&#x27;)&lt;/script&gt;", result)
        self.assertIn("Other &lt;News&gt;", result)
        self.assertIn("\\1", result)
        self.assertNotIn("<script>alert('x')</script>", result)
        self.assertNotIn("PRERENDERED_STORIES_START", result)
        self.assertIn("UPDATED 14:50 UTC", result)

    def test_normalizes_entry_only_payloads(self):
        result = render_page(TEMPLATE, {
            "entries": [{
                "title": "Standalone story",
                "url": "https://news.example/story",
                "source": "Example News",
                "category": "Science",
                "excerpt": "A concise source summary.",
            }]
        })

        self.assertIn("Standalone story", result)
        self.assertIn("Source:</span>", result)
        self.assertIn("1 story", result)

    def test_rejects_payloads_without_safe_story_links(self):
        with self.assertRaisesRegex(ValueError, "no stories with safe source links"):
            render_page(TEMPLATE, {"groups": [{
                "title": "Unsafe story",
                "url": "javascript:alert(1)",
                "sources": [{"source": "Unsafe", "url": "javascript:alert(1)"}],
            }]})


if __name__ == "__main__":
    unittest.main()
