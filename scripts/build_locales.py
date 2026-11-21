#!/usr/bin/env python3
"""Generate crawlable localized routes, metadata, and the multilingual sitemap."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from xml.sax.saxutils import escape as xml_escape

DEFAULT_SITE = "https://goodthingstoknowtoday.pages.dev"
STATIC_MESSAGE_KEYS = {
    "aboutLink",
    "aboutDescription",
    "aboutEyebrow",
    "allCategories",
    "allSources",
    "footerSlogan",
    "backToTop",
    "clearFilters",
    "dailyIssue",
    "donate",
    "emptyDescription",
    "emptyTitle",
    "feedErrorDescription",
    "feedErrorTitle",
    "heroEyebrow",
    "introDescription",
    "languageSelector",
    "noscriptStories",
    "oldestFirst",
    "readingList",
    "searchLabel",
    "sourceFilterLabel",
    "sortLabel",
    "retry",
    "sideMetaOne",
    "sideMetaTwo",
    "sideQuote",
    "title",
    "titleLine1",
    "titleLine2",
    "topbarNote",
    "newestFirst",
    "viewsToday",
    "viewsTotal",
}
STATIC_ATTRIBUTE_KEYS = {"homeLabel", "issueLabel", "viewsLabel"}


def _validate_catalog(catalog: dict[str, Any]) -> tuple[list[str], dict[str, Any], dict[str, Any]]:
    languages = catalog.get("languages")
    messages = catalog.get("messages")
    if not isinstance(languages, dict) or not isinstance(messages, dict) or not languages:
        raise ValueError("Locale catalog must contain language and message dictionaries")
    codes = list(languages)
    if set(codes) != set(messages):
        raise ValueError("Language definitions and message dictionaries must have matching locale codes")
    for code in codes:
        if not re.fullmatch(r"[a-z]{2}", code):
            raise ValueError(f"Invalid locale route code: {code}")
        language = languages[code]
        message = messages[code]
        if not isinstance(language, dict) or not isinstance(message, dict):
            raise ValueError(f"Locale entries for {code} must be objects")
        for key in STATIC_MESSAGE_KEYS | STATIC_ATTRIBUTE_KEYS:
            if not isinstance(message.get(key), str):
                raise ValueError(f"Locale {code} is missing the string message {key}")
        if not isinstance(message.get("categories"), dict) or not isinstance(message.get("monthsShort"), list):
            raise ValueError(f"Locale {code} must define category labels and month names")
        if len(message["monthsShort"]) != 12 or not all(isinstance(month, str) for month in message["monthsShort"]):
            raise ValueError(f"Locale {code} must define 12 abbreviated month names")
        if not all(isinstance(language.get(key), str) and language[key] for key in ("name", "locale", "providerName")):
            raise ValueError(f"Locale {code} must define name, locale, and providerName")
    return codes, languages, messages


def _format_message(value: str, **values: Any) -> str:
    for key, replacement in values.items():
        value = value.replace("{" + key + "}", str(replacement))
    return value


def _replace_data_text(document: str, key: str, value: str) -> str:
    pattern = re.compile(
        rf'(<(?P<tag>[A-Za-z][\w:-]*)\b(?=[^>]*\bdata-i18n="{re.escape(key)}")[^>]*>).*?(</(?P=tag)\s*>)',
        re.DOTALL,
    )
    updated, count = pattern.subn(lambda match: match.group(1) + html.escape(value) + match.group(3), document)
    if count != 1:
        raise ValueError(f"Homepage must contain exactly one data-i18n element for {key}")
    return updated


def _replace_i18n_attributes(document: str, messages: dict[str, Any]) -> str:
    pattern = re.compile(r"<[^>]*\bdata-i18n-attr=\"([^\"]+)\"[^>]*>")

    def replace_tag(match: re.Match[str]) -> str:
        tag = match.group(0)
        for directive in match.group(1).split(";"):
            if not directive.strip():
                continue
            attribute, separator, key = directive.partition(":")
            attribute = attribute.strip()
            key = key.strip()
            if not separator or attribute not in {"aria-label", "placeholder", "title"}:
                raise ValueError(f"Invalid localized HTML attribute directive: {directive}")
            value = messages.get(key)
            if not isinstance(value, str):
                raise ValueError(f"Locale is missing attribute message {key}")
            attr_pattern = re.compile(rf'(\b{re.escape(attribute)}=")[^"]*(")')
            tag, count = attr_pattern.subn(lambda attr: attr.group(1) + html.escape(value, quote=True) + attr.group(2), tag)
            if count != 1:
                raise ValueError(f"Localized element must have exactly one {attribute} attribute")
        return tag

    return pattern.sub(replace_tag, document)


def _replace_meta_content(document: str, messages: dict[str, Any]) -> str:
    pattern = re.compile(r"<meta\b(?=[^>]*\bdata-i18n-meta=\"([^\"]+)\")[^>]*>")

    def replace_tag(match: re.Match[str]) -> str:
        tag = match.group(0)
        key = match.group(1)
        value = messages.get(key)
        if not isinstance(value, str):
            raise ValueError(f"Locale is missing metadata message {key}")
        content_pattern = re.compile(r'(\bcontent=")[^"]*(")')
        tag, count = content_pattern.subn(lambda attr: attr.group(1) + html.escape(value, quote=True) + attr.group(2), tag)
        if count != 1:
            raise ValueError(f"Localized metadata must have exactly one content attribute for {key}")
        return tag

    return pattern.sub(replace_tag, document)


def _date_label(value: str, code: str, messages: dict[str, Any]) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return messages["dateUnknown"]
    months = messages["monthsShort"]
    month = months[parsed.month - 1]
    return f"{month} {parsed.day}" if code == "en" else f"{parsed.day} {month}"


def _localize_static_content(document: str, code: str, messages: dict[str, Any]) -> str:
    def replace_category(match: re.Match[str]) -> str:
        category = html.unescape(match.group(2))
        translated = messages["categories"].get(category, category)
        return match.group(1) + html.escape(translated) + match.group(3)

    document = re.sub(
        r'(<span class="story-category">)(.*?)(</span>)',
        replace_category,
        document,
    )

    def replace_date(match: re.Match[str]) -> str:
        opening, attributes, closing = match.group(1), match.group(2), match.group(3)
        datetime_match = re.search(r'\bdatetime="([^"]+)"', attributes)
        label = _date_label(datetime_match.group(1), code, messages) if datetime_match else messages["dateUnknown"]
        return opening + html.escape(label) + closing

    document = re.sub(r"(<time\b([^>]*)>).*?(</time>)", replace_date, document, flags=re.DOTALL)
    document = re.sub(
        r'(<div class="story-source"><span>)(Coverage:|Source:)(</span>)',
        lambda match: match.group(1) + (messages["coverageLabel"] if match.group(2) == "Coverage:" else messages["sourceLabel"]) + match.group(3),
        document,
    )
    def replace_additional_source(match: re.Match[str]) -> str:
        source = html.unescape(match.group(1))
        label = _format_message(messages["alsoReportedBy"], source=source)
        return "<strong>" + html.escape(label) + "</strong>"

    document = re.sub(r"<strong>Also reported by (.*?): </strong>", replace_additional_source, document)

    count_match = re.search(r'<span class="story-count" id="story-count">(\d+) (?:story|stories)</span>', document)
    if count_match:
        count = int(count_match.group(1))
        count_text = messages["storyCountSingular"] if count == 1 else messages["storyCountPlural"]
        document = document.replace(count_match.group(0), f'<span class="story-count" id="story-count">{html.escape(_format_message(count_text, count=count))}</span>', 1)

    document = document.replace(
        "DATE UNKNOWN",
        html.escape(messages["dateUnknown"]),
    )
    document = document.replace(
        "UPDATED ",
        html.escape(messages["updatedAtTemplate"].split("{time}")[0]),
    )
    document = document.replace(
        "LATEST EDITION",
        html.escape(messages["latestEdition"]),
    )
    return document


def _locale_options(languages: dict[str, Any], selected: str) -> str:
    return "\n".join(
        f'<option value="{html.escape(code, quote=True)}"{" selected" if code == selected else ""}>'
        f'{html.escape(language["name"])}</option>'
        for code, language in languages.items()
    )


def _root_redirect_script(codes: list[str]) -> str:
    supported = json.dumps(codes)
    return (
        "<script>\n"
        "(() => {\n"
        f"  const supported = new Set({supported});\n"
        '  const key = "news-aggregator-language";\n'
        "  const matchLanguage = (value) => {\n"
        '    const code = String(value || "").toLowerCase().split("-")[0];\n'
        "    return supported.has(code) ? code : null;\n"
        "  };\n"
        "  let language = null;\n"
        "  try { language = matchLanguage(localStorage.getItem(key)); } catch {}\n"
        "  if (!language) {\n"
        "    const preferences = Array.isArray(navigator.languages) && navigator.languages.length\n"
        "      ? navigator.languages : [navigator.language];\n"
        "    for (const preference of preferences) {\n"
        "      language = matchLanguage(preference);\n"
        "      if (language) break;\n"
        "    }\n"
        '    try { if (language) localStorage.setItem(key, language); } catch {}\n'
        "  }\n"
        '  if (window.location.pathname === "/" && language && language !== "en") {\n'
        '    window.location.replace("/" + language + "/" + window.location.search + window.location.hash);\n'
        "  }\n"
        "})();\n"
        "</script>"
    )


def _set_meta_content(document: str, selector: str, value: str) -> str:
    pattern = re.compile(rf"<meta\b(?=[^>]*\b{selector})[^>]*>")
    matches = list(pattern.finditer(document))
    if len(matches) != 1:
        raise ValueError(f"Homepage must contain exactly one metadata element matching {selector}")
    tag = matches[0].group(0)
    tag, count = re.subn(
        r'(\bcontent=")[^"]*(")',
        lambda match: match.group(1) + html.escape(value, quote=True) + match.group(2),
        tag,
        count=1,
    )
    if count != 1:
        raise ValueError(f"Metadata element matching {selector} must have a content attribute")
    return document[:matches[0].start()] + tag + document[matches[0].end():]


def _alternate_links(base_url: str, codes: list[str]) -> str:
    lines = [
        f'<link rel="alternate" hreflang="{code}" href="{base_url}/{code}/">'
        for code in codes
    ]
    lines.append(f'<link rel="alternate" hreflang="x-default" href="{base_url}/en/">')
    return "\n    ".join(lines)


def render_locale_page(
    template: str,
    code: str,
    base_url: str,
    codes: list[str],
    languages: dict[str, Any],
    messages: dict[str, Any],
    is_root: bool = False,
) -> str:
    document = template.replace(DEFAULT_SITE, base_url)
    for key in STATIC_MESSAGE_KEYS:
        value = messages[key]
        if key == "noscriptStories":
            value = _format_message(value, count=12)
        document = _replace_data_text(document, key, value)
    document = _replace_i18n_attributes(document, messages)
    document = _replace_meta_content(document, messages)

    path = "/" if is_root else f"/{code}/"
    canonical = base_url + path
    document, count = re.subn(
        r'<link rel="canonical" href="[^"]*">',
        f'<link rel="canonical" href="{html.escape(canonical, quote=True)}">',
        document,
        count=1,
    )
    if count != 1:
        raise ValueError("Homepage must contain exactly one canonical link")
    document, lang_count = re.subn(r'(<html\b[^>]*\blang=")[^"]*(")', rf'\1{code}\2', document, count=1)
    if lang_count != 1:
        raise ValueError("Homepage must contain an html lang attribute")
    if f'<html lang="{code}"' not in document and f'<html lang="{code}" ' not in document:
        raise ValueError("Homepage must contain an html lang attribute")
    document = _set_meta_content(document, r'\bproperty="og:url"', canonical)
    locale_tag = languages[code]["locale"].replace("-", "_")
    document = _set_meta_content(document, r'\bproperty="og:locale"', locale_tag)

    if "<!-- HREFLANG_LINKS -->" not in document:
        raise ValueError("Homepage is missing the hreflang insertion marker")
    document = document.replace("<!-- HREFLANG_LINKS -->", _alternate_links(base_url, codes), 1)
    document = document.replace("<!-- LOCALE_REDIRECT_SCRIPT -->", _root_redirect_script(codes) if is_root else "", 1)
    document = document.replace("<!-- LANGUAGE_OPTIONS -->", _locale_options(languages, code), 1)
    document = _localize_static_content(document, code, messages)

    json_ld = re.compile(r'(<script type="application/ld\+json">\s*)(\{.*?\})(\s*</script>)', re.DOTALL)
    match = json_ld.search(document)
    if not match:
        raise ValueError("Homepage must contain a JSON-LD WebSite script")
    structured = json.loads(match.group(2))
    structured["url"] = canonical
    structured["description"] = messages["description"]
    structured["inLanguage"] = languages[code]["locale"]
    encoded = json.dumps(structured, ensure_ascii=False, indent=2).replace("<", "\\u003c")
    document = document[:match.start()] + match.group(1) + encoded + match.group(3) + document[match.end():]
    return document


def build_sitemap(base_url: str, codes: list[str], lastmod: str | None = None) -> str:
    date = lastmod or datetime.now(timezone.utc).date().isoformat()
    paths = [f"/{code}/" for code in codes]
    entries = []
    alternates = _alternate_links(base_url, codes).replace("\n    ", "\n      ")
    alternates = alternates.replace('<link rel="alternate" hreflang=', '<xhtml:link rel="alternate" hreflang=').replace('">', '" />')
    for path in paths:
        location = xml_escape(base_url + path)
        entries.append(
            "  <url>\n"
            f"    <loc>{location}</loc>\n"
            f"    <lastmod>{date}</lastmod>\n"
            f"    {alternates}\n"
            "  </url>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
        'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n'
        + "\n".join(entries)
        + "\n</urlset>\n"
    )


def _base_url(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Base URL must be an HTTPS origin without a path, query, or fragment")
    return value.rstrip("/")


def build_site(site_dir: Path, base_url: str, locale_file: Path) -> int:
    base_url = _base_url(base_url)
    catalog = json.loads(locale_file.read_text(encoding="utf-8"))
    codes, languages, messages = _validate_catalog(catalog)
    template_path = site_dir / "index.html"
    template = template_path.read_text(encoding="utf-8")
    root = render_locale_page(template, "en", base_url, codes, languages, messages["en"], is_root=True)
    template_path.write_text(root, encoding="utf-8")

    for code in codes:
        if code == "en":
            page = render_locale_page(template, code, base_url, codes, languages, messages[code])
        else:
            page = render_locale_page(template, code, base_url, codes, languages, messages[code])
        route_dir = site_dir / code
        route_dir.mkdir(parents=True, exist_ok=True)
        (route_dir / "index.html").write_text(page, encoding="utf-8")

    (site_dir / "sitemap.xml").write_text(build_sitemap(base_url, codes), encoding="utf-8")
    (site_dir / "_routes.json").write_text(
        json.dumps({"version": 1, "include": ["/", "/api/translate"], "exclude": []}, indent=2) + "\n",
        encoding="utf-8",
    )
    return len(codes)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_dir", type=Path, help="Directory containing the prepared root index.html")
    parser.add_argument("--base-url", required=True, help="Canonical HTTPS origin for this Pages project")
    parser.add_argument("--locales-file", type=Path, default=Path("locales.json"))
    args = parser.parse_args(argv)
    try:
        count = build_site(args.site_dir, args.base_url, args.locales_file)
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        print(f"Could not build localized routes: {error}", file=sys.stderr)
        return 1
    print(f"Generated {count} localized routes, hreflang metadata, and sitemap.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
