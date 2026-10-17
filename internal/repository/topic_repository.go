// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// Topic 话题记录；ActiveNodeID 是当前活动分支的末端消息 ID（空表示话题还没有消息）。
// FolderID 是所属话题目录（空表示位于所在区域的根级）；Favorite 表示是否收藏；
// SortOrder 是话题在其容器（folder_id + favorite 一致）内的排序下标。
type Topic struct {
	ID, AssistantID, Title, ActiveNodeID, FolderID string
	Favorite                                       bool
	SortOrder                                      int
	CreatedAt, UpdatedAt                           int64
}

// TopicRepo topics 表读写。
type TopicRepo struct {
	db *database.DB
}

// NewTopicRepo 构造 TopicRepo。
func NewTopicRepo(db *database.DB) *TopicRepo {
	return &TopicRepo{db: db}
}

// topicColumns 是 topics 的统一查询列，顺序必须与 scanTopic 一致。
const topicColumns = `id, assistant_id, title, active_node_id, folder_id, favorite, sort_order, created_at, updated_at`

func scanTopic(s rowScanner) (Topic, error) {
	var (
		t        Topic
		favorite int64
	)
	if err := s.Scan(&t.ID, &t.AssistantID, &t.Title, &t.ActiveNodeID, &t.FolderID, &favorite, &t.SortOrder, &t.CreatedAt, &t.UpdatedAt); err != nil {
		return Topic{}, err
	}
	t.Favorite = favorite != 0
	return t, nil
}

// ListByAssistant 返回某助手的话题，按 updated_at 倒序。
func (r *TopicRepo) ListByAssistant(assistantID string) ([]Topic, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT `+topicColumns+` FROM topics WHERE assistant_id = ? ORDER BY updated_at DESC, created_at DESC`, assistantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Topic, 0, 8)
	for rows.Next() {
		t, err := scanTopic(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// Get 按 id 读取话题。
func (r *TopicRepo) Get(id string) (Topic, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT `+topicColumns+` FROM topics WHERE id = ?`, id)
	t, err := scanTopic(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Topic{}, ErrNotFound
	}
	if err != nil {
		return Topic{}, err
	}
	return t, nil
}

// Create 新增话题。
func (r *TopicRepo) Create(t Topic) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO topics (id, assistant_id, title, active_node_id, folder_id, favorite, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		t.ID, t.AssistantID, t.Title, t.ActiveNodeID, t.FolderID, boolToInt(t.Favorite), t.SortOrder, t.CreatedAt, t.UpdatedAt)
	return err
}

// SetPlacement 更新话题所属目录与收藏标记，并刷新 updated_at。
func (r *TopicRepo) SetPlacement(id string, folderID string, favorite bool, now int64) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topics SET folder_id = ?, favorite = ?, updated_at = ? WHERE id = ?`, folderID, boolToInt(favorite), now, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetSortOrder 更新话题在其容器内的排序下标（不刷新 updated_at）。
func (r *TopicRepo) SetSortOrder(id string, order int) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topics SET sort_order = ? WHERE id = ?`, order, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// ListSiblings 返回同一容器内（assistant_id + folder_id + favorite 一致）的话题，按 sort_order, updated_at 排序。
func (r *TopicRepo) ListSiblings(assistantID string, folderID string, favorite bool) ([]Topic, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT `+topicColumns+` FROM topics WHERE assistant_id = ? AND folder_id = ? AND favorite = ? ORDER BY sort_order, updated_at`, assistantID, folderID, boolToInt(favorite))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Topic, 0, 8)
	for rows.Next() {
		t, err := scanTopic(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// Rename 重命名话题并刷新 updated_at。
func (r *TopicRepo) Rename(id string, title string, now int64) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topics SET title = ?, updated_at = ? WHERE id = ?`, title, now, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Delete 删除话题（其消息级联删除）。
func (r *TopicRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM topics WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Touch 刷新话题 updated_at（消息写入后调用）。
func (r *TopicRepo) Touch(id string, now int64) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topics SET updated_at = ? WHERE id = ?`, now, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetActiveNode 把话题的活动分支末端切到指定消息。
func (r *TopicRepo) SetActiveNode(id string, nodeID string, now int64) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topics SET active_node_id = ?, updated_at = ? WHERE id = ?`, nodeID, now, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// HasBranchesByAssistant 返回该助手下「存在分支」的话题集合：
// 同一父节点下有多条消息（COUNT(1) > COUNT(DISTINCT parent_id)）即视为有分支。
func (r *TopicRepo) HasBranchesByAssistant(assistantID string) (map[string]bool, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT m.topic_id, COUNT(1), COUNT(DISTINCT m.parent_id) FROM messages m JOIN topics t ON t.id = m.topic_id WHERE t.assistant_id = ? GROUP BY m.topic_id`, assistantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	branched := make(map[string]bool)
	for rows.Next() {
		var (
			topicID string
			total   int
			parents int
		)
		if err := rows.Scan(&topicID, &total, &parents); err != nil {
			return nil, err
		}
		if total > parents {
			branched[topicID] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return branched, nil
}

// CountMessages 统计话题下的消息数。
func (r *TopicRepo) CountMessages(topicID string) (int, error) {
	var count int
	if err := r.db.SQL().QueryRowContext(context.Background(), `SELECT COUNT(1) FROM messages WHERE topic_id = ?`, topicID).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
