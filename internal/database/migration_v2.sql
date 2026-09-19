-- MyAIUI2 schema v1 → v2 增量迁移：把线性消息表改造成消息树（parent_id + topics.active_node_id）。
-- 由 execScript 按分号拆分执行，禁止触发器/存储过程等多语句块。

-- 1) 话题增加活动分支末端节点列。
ALTER TABLE topics ADD COLUMN active_node_id TEXT NOT NULL DEFAULT '';

-- 2) 重建 messages：去掉 UNIQUE(topic_id, sort_order)，新增 parent_id（分支下同序号兄弟合法）。
CREATE TABLE messages_v2 (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  parent_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  provider_id TEXT,
  model_remote_id TEXT,
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 3) 拷贝历史消息，parent_id 先留空。
INSERT INTO messages_v2 (id, topic_id, parent_id, role, status, parts_json, provider_id, model_remote_id, sort_order, created_at, updated_at) SELECT id, topic_id, '', role, status, parts_json, provider_id, model_remote_id, sort_order, created_at, updated_at FROM messages;

-- 4) 按原线性顺序回填父链：每个节点指向同话题中 sort_order 紧邻的前一条（首条为根）。
UPDATE messages_v2 SET parent_id = COALESCE((SELECT m2.id FROM messages_v2 m2 WHERE m2.topic_id = messages_v2.topic_id AND m2.sort_order < messages_v2.sort_order ORDER BY m2.sort_order DESC LIMIT 1), '');

-- 5) 用新表替换旧表。
DROP TABLE messages;

ALTER TABLE messages_v2 RENAME TO messages;

-- 6) 重建索引（旧表索引随 DROP 一并消失）。
CREATE INDEX idx_messages_topic_order ON messages(topic_id, sort_order);

CREATE INDEX idx_messages_topic_parent ON messages(topic_id, parent_id, sort_order);

-- 7) 活动节点回填到每条话题的末条消息。
UPDATE topics SET active_node_id = COALESCE((SELECT id FROM messages WHERE topic_id = topics.id ORDER BY sort_order DESC LIMIT 1), '');
