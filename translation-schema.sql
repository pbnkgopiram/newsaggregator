CREATE TABLE IF NOT EXISTS news_translations (
  article_id TEXT NOT NULL,
  language TEXT NOT NULL,
  content_version TEXT NOT NULL,
  translated_title TEXT NOT NULL,
  translated_summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (article_id, language, content_version)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS news_translations_created_at
  ON news_translations (created_at);

CREATE TABLE IF NOT EXISTS news_articles (
  article_id TEXT PRIMARY KEY,
  story_key TEXT NOT NULL,
  content_version TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT NOT NULL,
  category TEXT NOT NULL,
  published_at TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS news_articles_content_version
  ON news_articles (article_id, content_version);

CREATE TABLE IF NOT EXISTS translation_index_daily_usage (
  day_utc TEXT PRIMARY KEY,
  translated_items INTEGER NOT NULL CHECK (translated_items >= 0)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS translation_daily_usage (
  client_hash TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  translated_items INTEGER NOT NULL CHECK (translated_items >= 0),
  PRIMARY KEY (client_hash, day_utc)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS translation_daily_usage_day
  ON translation_daily_usage (day_utc);
