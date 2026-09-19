// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// defaultMessageLimit 分页未指定 limit 时取的条数。
const defaultMessageLimit = 50

// Message 消息记录，parts_json 保存消息片段数组。
type Message struct {
	ID, TopicID, Role, Status, PartsJSON, ProviderID, ModelRemoteID string
	SortOrder                                                       int
	CreatedAt, UpdatedAt                                            int64
}

// MessageRepo messages 表读写。
type MessageRepo struct {
	db *database.DB
}

// NewMessageRepo 构造 MessageRepo。
func NewMessageRepo(db *database.DB) *MessageRepo {
	return &MessageRepo{db: db}
}

func scanMessage(s rowScanner) (Message, error) {
	var m Message
	if err := s.Scan(&m.ID, &m.TopicID, &m.Role, &m.Status, &m.PartsJSON, &m.ProviderID, &m.ModelRemoteID,
		&m.SortOrder, &m.CreatedAt, &m.UpdatedAt); err != nil {
		return Message{}, err
	}
	return m, nil
}

func scanMessages(rows *sql.Rows) ([]Message, error) {
	list := make([]Message, 0, 16)
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

func reverseMessages(list []Message) {
	for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
		list[i], list[j] = list[j], list[i]
	}
}

// Get 按 id 读取消息。
func (r *MessageRepo) Get(id string) (Message, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT id, topic_id, role, status, parts_json, COALESCE(provider_id, ''), COALESCE(model_remote_id, ''), sort_order, created_at, updated_at FROM messages WHERE id = ?`, id)
	m, err := scanMessage(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	return m, nil
}

// Create 新增消息。
func (r *MessageRepo) Create(m Message) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO messages (id, topic_id, role, status, parts_json, provider_id, model_remote_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.TopicID, m.Role, m.Status, m.PartsJSON, nilIfEmpty(m.ProviderID), nilIfEmpty(m.ModelRemoteID),
		m.SortOrder, m.CreatedAt, m.UpdatedAt)
	return err
}

// NextSortOrder 返回该话题的下一个排序值（空话题从 1 开始）。
func (r *MessageRepo) NextSortOrder(topicID string) (int, error) {
	var next int
	if err := r.db.SQL().QueryRowContext(context.Background(), `SELECT COALESCE(MAX(sort_order), 0) + 1 FROM messages WHERE topic_id = ?`, topicID).Scan(&next); err != nil {
		return 0, err
	}
	return next, nil
}

// ListByTopic 返回升序消息：beforeOrder<=0 取最后 limit 条，否则取 sort_order 小于 beforeOrder 的最后 limit 条。
func (r *MessageRepo) ListByTopic(topicID string, beforeOrder int, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = defaultMessageLimit
	}
	ctx := context.Background()
	var (
		rows *sql.Rows
		err  error
	)
	if beforeOrder > 0 {
		rows, err = r.db.SQL().QueryContext(ctx, `SELECT id, topic_id, role, status, parts_json, COALESCE(provider_id, ''), COALESCE(model_remote_id, ''), sort_order, created_at, updated_at FROM messages WHERE topic_id = ? AND sort_order < ? ORDER BY sort_order DESC LIMIT ?`, topicID, beforeOrder, limit)
	} else {
		rows, err = r.db.SQL().QueryContext(ctx, `SELECT id, topic_id, role, status, parts_json, COALESCE(provider_id, ''), COALESCE(model_remote_id, ''), sort_order, created_at, updated_at FROM messages WHERE topic_id = ? ORDER BY sort_order DESC LIMIT ?`, topicID, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list, err := scanMessages(rows)
	if err != nil {
		return nil, err
	}
	reverseMessages(list)
	return list, nil
}

// ListRecent 返回升序的最后 limit 条消息。
func (r *MessageRepo) ListRecent(topicID string, limit int) ([]Message, error) {
	return r.ListByTopic(topicID, 0, limit)
}

// UpdateParts 流式快照：只更新 parts_json/status/updated_at。
func (r *MessageRepo) UpdateParts(id string, partsJSON string, status string, now int64) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE messages SET parts_json = ?, status = ?, updated_at = ? WHERE id = ?`, partsJSON, status, now, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Finish 结束一轮生成：写入最终 parts 与状态；错误文案已由调用方拼进 parts。
func (r *MessageRepo) Finish(id string, partsJSON string, status string, errorCode string, errorMessage string, now int64) error {
	_ = errorCode    // 错误片段由调用方写入 parts_json
	_ = errorMessage // 同上
	return r.UpdateParts(id, partsJSON, status, now)
}

// Delete 删除消息。
func (r *MessageRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM messages WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// MarkStreamingAsInterrupted 启动时把中断残留的生成中消息置为 interrupted。
func (r *MessageRepo) MarkStreamingAsInterrupted(now int64) (int, error) {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status IN ('pending', 'streaming')`, now)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}
