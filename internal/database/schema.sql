-- MyAIUI2 原创实现（表结构照抄实施方案 §9.2，一次性 schema，由 user_version 控制执行）。
-- 注意：本文件由 execScript 按分号拆分执行，不要写触发器/存储过程等多语句块。

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_cipher BLOB,
  enabled INTEGER NOT NULL DEFAULT 1,
  model_path TEXT NOT NULL DEFAULT '/models',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_sync_error TEXT
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT 'text',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'synced',
  enabled INTEGER NOT NULL DEFAULT 1,
  missing_remote INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  UNIQUE(provider_id, remote_id)
);

CREATE TABLE assistants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id TEXT REFERENCES providers(id),
  model_id TEXT REFERENCES models(id),
  temperature REAL,
  web_search_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  provider_id TEXT,
  model_remote_id TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(topic_id, sort_order)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_topics_assistant_updated ON topics(assistant_id, updated_at DESC);
CREATE INDEX idx_messages_topic_order ON messages(topic_id, sort_order);
CREATE INDEX idx_models_provider_enabled ON models(provider_id, enabled);
