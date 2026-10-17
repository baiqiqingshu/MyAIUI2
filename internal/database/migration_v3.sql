-- MyAIUI2 schema v2 → v3 增量迁移：话题目录与收藏（topic_folders 表 + topics.folder_id/favorite/sort_order）。
-- 由 execScript 按分号拆分执行，禁止触发器/存储过程等多语句块。

-- 1) 话题增加所属目录、收藏标记与容器内排序下标列。
ALTER TABLE topics ADD COLUMN folder_id TEXT NOT NULL DEFAULT '';

ALTER TABLE topics ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;

ALTER TABLE topics ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- 2) 话题目录表：zone 为空串表示普通区目录，'fav' 表示收藏区目录；parent_id 为空表示根级目录。
CREATE TABLE topic_folders (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3) 目录按助手与区域查询的索引。
CREATE INDEX idx_topic_folders_assistant ON topic_folders(assistant_id, zone, sort_order);
