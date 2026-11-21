#!/usr/bin/env python3
"""Render a small source-linked story batch into the static homepage HTML."""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

PRERENDER_LIMIT = 12
STORIES_START = "<!-- PRERENDERED_STORIES_START -->"
STORIES_END = "<!-- PRERENDERED_STORIES_END -->"
CATEGORY_PRIORITY = {"World": 0, "Business": 1, "Science": 2, "Technology": 3}
STORY_LIST_OPEN = '<div class="story-list" id="story-list" aria-live="polite" aria-busy="true">'


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _safe_url(value: Any) -> str:
    candidate = _text(value)
    if not candidate:
        return ""
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    return candidate if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _parse_date(value: Any) -> datetime | None:
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _story_sources(story: dict[str, Any]) -> list[dict[str, Any]]:
    raw_sources = story.get("sources")
    if not isinstance(raw_sources, list):
        return []
    sources = []
    for raw_source in raw_sources:
        if not isinstance(raw_source, dict):
            continue
        url = _safe_url(raw_source.get("url") or raw_source.get("link"))
        if not url:
            continue
        source = dict(raw_source)
        source["url"] = url
        source["source"] = _text(source.get("source") or source.get("name")) or "Original source"
        sources.append(source)
    return sources


def _normalized_stories(data: dict[str, Any]) -> list[dict[str, Any]]:
    groups = data.get("groups")
    stories: list[dict[str, Any]] = []
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict):
                continue
            sources = _story_sources(group)
            if not sources:
                continue
            story = dict(group)
            story["sources"] = sources
            story["url"] = _safe_url(group.get("url") or group.get("link")) or sources[0]["url"]
            stories.append(story)
    else:
        entries = data.get("entries")
        if isinstance(entries, list):
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                url = _safe_url(entry.get("url") or entry.get("link"))
                if not url:
                    continue
                title = _text(entry.get("title")) or "Untitled story"
                excerpt = _text(entry.get("excerpt"))
                source = _text(entry.get("source") or entry.get("name")) or "Original source"
                stories.append({
                    "title": title,
                    "url": url,
                    "category": entry.get("category"),
                    "publishedAt": entry.get("publishedAt"),
                    "summary": excerpt,
                    "sources": [{"source": source, "url": url, "title": title, "excerpt": excerpt}],
                    "additionalCoverage": [],
                })

    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    stories.sort(key=lambda story: _parse_date(story.get("publishedAt")) or epoch, reverse=True)
    stories.sort(key=lambda story: CATEGORY_PRIORITY.get(_text(story.get("category")), len(CATEGORY_PRIORITY)))
    return stories


def _teaser_lines(story: dict[str, Any]) -> list[str]:
    raw = _text(story.get("summary") or story.get("excerpt") or story.get("title"))
    cleaned = re.sub(r"https?://\S+", "", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).replace("\u2018", "").replace("\u2019", "").replace("\u201c", "").replace("\u201d", "").strip()
    if not cleaned:
        return []
    words = cleaned.split()
    if len(words) <= 10:
        return [cleaned]
    chunk_count = min(5, max(2, math.ceil(len(words) / 12)))
    chunk_size = math.ceil(len(words) / chunk_count)
    return [" ".join(words[index:index + chunk_size]) for index in range(0, len(words), chunk_size)][:5]


def _render_story(story: dict[str, Any], index: int) -> str:
    escape = html.escape
    category = _text(story.get("category")) or "General"
    title = _text(story.get("title")) or "Untitled story"
    story_url = _safe_url(story.get("url") or story.get("link"))
    published = _parse_date(story.get("publishedAt"))
    date_text = published.strftime("%b %d").upper().replace(" 0", " ") if published else "DATE UNKNOWN"
    datetime_attr = f' datetime="{escape(published.isoformat(timespec="seconds"), quote=True)}"' if published else ""
    parts = [
        f'<article class="story-card" style="animation-delay: {min(index, 8) * 35}ms">',
        '  <div class="story-meta">',
        f'    <span class="story-category">{escape(category)}</span>',
        f'    <time class="story-date"{datetime_attr}>{date_text}</time>',
        "  </div>",
        '  <div class="story-body">',
        '    <h3 class="story-title">',
        f'      <a href="{escape(story_url, quote=True)}" target="_blank" rel="noopener noreferrer">{escape(title)}</a>',
        "    </h3>",
    ]

    teaser_lines = _teaser_lines(story)
    if teaser_lines:
        parts.append('    <div class="story-summary">')
        parts.extend(f'      <span class="story-summary-line">{escape(line)}</span>' for line in teaser_lines)
        parts.append("    </div>")

    summary = _text(story.get("summary"))
    excerpt = _text(story.get("excerpt"))
    teaser_text = " ".join(teaser_lines).strip()
    should_show_excerpt = bool(summary and summary != teaser_text and summary != excerpt) or bool(summary and not teaser_text and excerpt != summary)
    if should_show_excerpt:
        parts.append(f'    <p class="story-excerpt">{escape(summary)}</p>')

    coverage = story.get("additionalCoverage")
    if isinstance(coverage, list):
        for item in coverage:
            if not isinstance(item, dict):
                continue
            additional_excerpt = _text(item.get("excerpt"))
            if not additional_excerpt:
                continue
            source_name = _text(item.get("source") or item.get("name")) or "Another source"
            parts.append(
                '    <p class="story-excerpt additional-coverage">'
                f'<strong>Also reported by {escape(source_name)}: </strong>{escape(additional_excerpt)}</p>'
            )

    sources = _story_sources(story)
    parts.append(f'    <div class="story-source"><span>{"Coverage:" if len(sources) > 1 else "Source:"}</span>')
    for source_index, source in enumerate(sources):
        if source_index:
            parts.append('<span class="source-dot"></span>')
        source_name = _text(source.get("source") or source.get("name")) or "Original source"
        parts.append(
            f'<a class="read-link" href="{escape(source["url"], quote=True)}" '
            f'target="_blank" rel="noopener noreferrer">{escape(source_name)} ↗</a>'
        )
    parts.extend(["    </div>", "  </div>", "</article>"])
    return "\n".join(parts)


def render_page(template: str, data: dict[str, Any], limit: int = PRERENDER_LIMIT) -> str:
    if not isinstance(data, dict):
        raise ValueError("Feed data must be a JSON object")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        raise ValueError("Prerender limit must be at least one")
    stories = _normalized_stories(data)
    if not stories:
        raise ValueError("Feed data contains no stories with safe source links")
    if template.count(STORIES_START) != 1 or template.count(STORIES_END) != 1:
        raise ValueError("Homepage must contain exactly one prerender marker pair")
    if template.count(STORY_LIST_OPEN) != 1:
        raise ValueError("Homepage must contain exactly one story-list container")

    story_markup = "\n".join(_render_story(story, index) for index, story in enumerate(stories[:limit]))
    marker_block = re.compile(re.escape(STORIES_START) + r".*?" + re.escape(STORIES_END), re.DOTALL)
    if marker_block.search(template) is None:
        raise ValueError("Homepage prerender markers are out of order")
    rendered = marker_block.sub(lambda _: story_markup, template, count=1)
    rendered = _replace_once(rendered, STORY_LIST_OPEN, STORY_LIST_OPEN.replace('aria-busy="true"', 'aria-busy="false"'), "story-list container")
    rendered = _replace_once(
        rendered,
        '<span class="story-count" id="story-count">— stories</span>',
        f'<span class="story-count" id="story-count">{len(stories)} {"story" if len(stories) == 1 else "stories"}</span>',
        "story count",
    )
    rendered = _replace_once(
        rendered,
        '<span class="category-count" data-count="all">0</span>',
        f'<span class="category-count" data-count="all">{len(stories)}</span>',
        "total category count",
    )

    generated = _parse_date(data.get("generatedAt"))
    issue_number = f"{generated.day:02d}" if generated else "01"
    updated = f"UPDATED {generated.strftime('%H:%M UTC')}" if generated else "LATEST EDITION"
    rendered = _replace_once(rendered, '<span id="issue-number">01</span>', f'<span id="issue-number">{issue_number}</span>', "issue number")
    return _replace_once(
        rendered,
        '<span class="stamp-bottom" id="updated-at">UPDATING…</span>',
        f'<span class="stamp-bottom" id="updated-at">{html.escape(updated)}</span>',
        "update timestamp",
    )


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    if source.count(old) != 1:
        raise ValueError(f"Homepage must contain exactly one {label} placeholder")
    return source.replace(old, new, 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("feed_data", type=Path)
    parser.add_argument("html_file", type=Path)
    args = parser.parse_args(argv)

    try:
        data = json.loads(args.feed_data.read_text(encoding="utf-8"))
        template = args.html_file.read_text(encoding="utf-8")
        rendered = render_page(template, data)
        story_count = len(_normalized_stories(data))
        args.html_file.write_text(rendered, encoding="utf-8")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Could not prerender homepage: {error}", file=sys.stderr)
        return 1

    print(f"Pre-rendered {min(PRERENDER_LIMIT, story_count)} of {story_count} stories.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
