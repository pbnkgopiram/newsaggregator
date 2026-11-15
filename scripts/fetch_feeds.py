#!/usr/bin/env python3
"""Fetch public RSS/Atom feeds and write a compact, source-linked JSON digest."""

from __future__ import annotations

import email.utils
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SOURCES_PATH = ROOT / "sources.json"
OUTPUT_PATH = ROOT / "data" / "feeds.json"
USER_AGENT = "FieldnotesFeedCollector/1.0 (+https://github.com/)"
MAX_RESPONSE_BYTES = 2_000_000
MAX_ITEMS_PER_SOURCE = 24
MAX_EXCERPT_LENGTH = 360
MAX_TOTAL_ENTRIES = 160
MAX_GROUP_AGE_HOURS = 48
TITLE_STOP_WORDS = {
    "about", "after", "amid", "and", "are", "around", "been", "before", "being", "but",
    "for", "from", "have", "into", "its", "more", "new", "over", "said", "says", "than",
    "that", "the", "their", "them", "there", "they", "this", "under", "with", "will",
}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def clean_excerpt(value: str, limit: int = MAX_EXCERPT_LENGTH) -> str:
    extractor = _TextExtractor()
    try:
        extractor.feed(value)
        extractor.close()
        text = " ".join(extractor.parts)
    except Exception:
        text = value
    text = html.unescape(text)
    text = re.sub(r"(?is)\b(?:Article URL|Comments URL)\s*:?\s*(?:https?://\S+)?", " ", text)
    text = re.sub(r"(?is)\bSource\s*:\s*\[[^\]]+\]\([^)]*\)", " ", text)
    text = re.sub(r"(?is)\bSource\s*:\s*https?://\S+", " ", text)
    text = re.sub(r"(?is)\bPoints\s*:\s*\d+\s*", " ", text)
    text = re.sub(r"(?is)#\s*Comments\s*:\s*\d+\s*", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if len(text) > limit:
        return text[: limit - 1].rsplit(" ", 1)[0].rstrip(".,;:") + "…"
    return text


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def _child_text(element: ET.Element, *names: str) -> str:
    wanted = {name.lower() for name in names}
    for child in element.iter():
        if child is element or _local_name(child.tag) not in wanted:
            continue
        value = "".join(child.itertext()).strip()
        if value:
            return value
    return ""


def _entry_link(element: ET.Element) -> str:
    for child in element:
        if _local_name(child.tag) != "link":
            continue
        href = child.attrib.get("href", "").strip()
        rel = child.attrib.get("rel", "alternate")
        candidate = href if href and rel == "alternate" else (child.text or "").strip()
        if candidate:
            return candidate
    return ""


def _safe_http_url(value: str, base: str = "") -> str:
    resolved = urllib.parse.urljoin(base, value.strip()) if base else value.strip()
    parsed = urllib.parse.urlparse(resolved)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ""
    return resolved


def _iso_date(value: str) -> str | None:
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _title_tokens(title: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]+", title.lower())
        if len(token) > 2 and token not in TITLE_STOP_WORDS
    }


def _can_group(first: dict[str, Any], second: dict[str, Any]) -> bool:
    if first["source"] == second["source"] or first["category"] != second["category"]:
        return False
    first_date = _iso_date(first.get("publishedAt") or "")
    second_date = _iso_date(second.get("publishedAt") or "")
    if first_date and second_date:
        gap = abs((datetime.fromisoformat(first_date) - datetime.fromisoformat(second_date)).total_seconds())
        if gap > MAX_GROUP_AGE_HOURS * 3600:
            return False

    first_tokens = _title_tokens(first["title"])
    second_tokens = _title_tokens(second["title"])
    shared = first_tokens & second_tokens
    smaller_title_size = min(len(first_tokens), len(second_tokens))
    return smaller_title_size >= 3 and len(shared) >= 3 and len(shared) / smaller_title_size >= 0.6


def group_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    clusters: list[list[dict[str, Any]]] = []
    for entry in sorted(entries, key=lambda item: item.get("publishedAt") or "", reverse=True):
        matching_cluster = next(
            (
                cluster
                for cluster in clusters
                if all(existing["source"] != entry["source"] for existing in cluster)
                and any(_can_group(existing, entry) for existing in cluster)
            ),
            None,
        )
        if matching_cluster is None:
            clusters.append([entry])
        else:
            matching_cluster.append(entry)

    groups: list[dict[str, Any]] = []
    for cluster in clusters:
        lead = max(cluster, key=lambda item: item.get("publishedAt") or "")
        excerpts: list[str] = []
        for item in cluster:
            if item.get("excerpt") and item["excerpt"] not in excerpts:
                excerpts.append(item["excerpt"])
        group_id = hashlib.sha1(lead["url"].encode("utf-8")).hexdigest()[:12]
        groups.append(
            {
                "id": group_id,
                "title": lead["title"],
                "url": lead.get("url", ""),
                "category": lead["category"],
                "publishedAt": lead.get("publishedAt"),
                "summary": lead.get("excerpt", ""),
                "additionalCoverage": [
                    {
                        "source": item["source"],
                        "url": item["url"],
                        "excerpt": item["excerpt"],
                    }
                    for item in cluster
                    if item is not lead and item.get("excerpt") and item["excerpt"] not in {lead.get("excerpt", "")}
                ],
                "sources": cluster,
            }
        )
    return groups


def parse_feed(xml_bytes: bytes, source: dict[str, str], limit: int = MAX_ITEMS_PER_SOURCE) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_bytes)
    root_name = _local_name(root.tag)
    if root_name == "rss":
        channel = next((child for child in root if _local_name(child.tag) == "channel"), root)
        elements = [child for child in channel if _local_name(child.tag) == "item"]
    elif root_name == "feed":
        elements = [child for child in root if _local_name(child.tag) == "entry"]
    else:
        elements = [child for child in root.iter() if _local_name(child.tag) in {"item", "entry"}]

    entries: list[dict[str, Any]] = []
    for element in elements[:limit]:
        url = _safe_http_url(_entry_link(element), source["url"])
        title = _child_text(element, "title")
        if not url or not title:
            continue
        excerpt = _child_text(element, "description", "summary", "encoded", "content")
        published = _child_text(element, "pubdate", "published", "updated", "date")
        entries.append(
            {
                "title": clean_excerpt(title, 240),
                "url": url,
                "excerpt": clean_excerpt(excerpt),
                "publishedAt": _iso_date(published),
                "source": source["name"],
                "category": source.get("category", "General"),
            }
        )
    return entries


def fetch_source(source: dict[str, str]) -> tuple[list[dict[str, Any]], str | None]:
    url = _safe_http_url(source.get("url", ""))
    if not url:
        return [], "Feed URL must use HTTP or HTTPS"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5"})
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
        if len(payload) > MAX_RESPONSE_BYTES:
            return [], "Feed response exceeded the 2 MB limit"
        return parse_feed(payload, source), None
    except (urllib.error.URLError, TimeoutError, OSError, ET.ParseError, ValueError) as error:
        return [], f"{type(error).__name__}: {error}"


def collect(sources: list[dict[str, str]]) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    statuses: list[dict[str, Any]] = []
    for source in sources:
        if not source.get("name") or not source.get("url"):
            statuses.append({"name": source.get("name", "Unnamed source"), "ok": False, "error": "Each source needs a name and URL"})
            continue
        found, error = fetch_source(source)
        accepted = 0
        for entry in found:
            normalized_url = entry["url"].split("#", 1)[0]
            if normalized_url in seen_urls:
                continue
            seen_urls.add(normalized_url)
            entries.append(entry)
            accepted += 1
        statuses.append({"name": source["name"], "ok": error is None, "items": accepted, **({"error": error} if error else {})})
        if len(entries) >= MAX_TOTAL_ENTRIES:
            entries = entries[:MAX_TOTAL_ENTRIES]
            break
        time.sleep(0.15)

    entries.sort(key=lambda entry: entry["publishedAt"] or "", reverse=True)
    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": statuses,
        "entries": entries,
        "groups": group_entries(entries),
    }


def main() -> int:
    try:
        sources = json.loads(SOURCES_PATH.read_text(encoding="utf-8"))
        if not isinstance(sources, list):
            raise ValueError("sources.json must contain a list")
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"Could not read {SOURCES_PATH}: {error}", file=sys.stderr)
        return 1

    result = collect(sources)
    if result["sources"] and not result["entries"] and all(not source["ok"] for source in result["sources"]):
        print("Every configured feed failed; keeping the previous digest unchanged.", file=sys.stderr)
        return 1
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    failed = sum(not source["ok"] for source in result["sources"])
    print(f"Wrote {len(result['entries'])} stories from {len(result['sources'])} sources ({failed} unavailable).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())