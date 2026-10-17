// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// TopicFolder 话题目录记录；Zone 为空串表示普通区目录，'fav' 表示收藏区目录；
// ParentID 为空串表示该 zone 的根级目录，SortOrder 是同级容器内的排序下标。
type TopicFolder struct {
	ID, AssistantID, ParentID, Name, Zone string
	SortOrder                             int
	CreatedAt, UpdatedAt                  int64
}

// TopicFolderRepo topic_folders 表读写。
type TopicFolderRepo struct {
	db *database.DB
}

// NewTopicFolderRepo 构造 TopicFolderRepo。
func NewTopicFolderRepo(db *database.DB) *TopicFolderRepo {
	return &TopicFolderRepo{db: db}
}

// topicFolderColumns 是 topic_folders 的统一查询列，顺序必须与 scanTopicFolder 一致。
const topicFolderColumns = `id, assistant_id, parent_id, name, zone, sort_order, created_at, updated_at`

func scanTopicFolder(s rowScanner) (TopicFolder, error) {
	var f TopicFolder
	if err := s.Scan(&f.ID, &f.AssistantID, &f.ParentID, &f.Name, &f.Zone, &f.SortOrder, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return TopicFolder{}, err
	}
	return f, nil
}

func scanTopicFolders(rows *sql.Rows) ([]TopicFolder, error) {
	list := make([]TopicFolder, 0, 8)
	for rows.Next() {
		f, err := scanTopicFolder(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// ListByAssistant 返回某助手的全部目录，按 zone, sort_order 排序（前端自行组树）。
func (r *TopicFolderRepo) ListByAssistant(assistantID string) ([]TopicFolder, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT `+topicFolderColumns+` FROM topic_folders WHERE assistant_id = ? ORDER BY zone, sort_order`, assistantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTopicFolders(rows)
}

// ListChildren 返回同一容器内（assistant_id + parent_id + zone 一致）的目录，按 sort_order, updated_at 排序。
func (r *TopicFolderRepo) ListChildren(assistantID string, parentID string, zone string) ([]TopicFolder, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT `+topicFolderColumns+` FROM topic_folders WHERE assistant_id = ? AND parent_id = ? AND zone = ? ORDER BY sort_order, updated_at`, assistantID, parentID, zone)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanTopicFolders(rows)
}

// Get 按 id 读取目录。
func (r *TopicFolderRepo) Get(id string) (TopicFolder, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT `+topicFolderColumns+` FROM topic_folders WHERE id = ?`, id)
	f, err := scanTopicFolder(row)
	if errors.Is(err, sql.ErrNoRows) {
		return TopicFolder{}, ErrNotFound
	}
	if err != nil {
		return TopicFolder{}, err
	}
	return f, nil
}

// Create 新增目录。
func (r *TopicFolderRepo) Create(f TopicFolder) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO topic_folders (id, assistant_id, parent_id, name, zone, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		f.ID, f.AssistantID, f.ParentID, f.Name, f.Zone, f.SortOrder, f.CreatedAt, f.UpdatedAt)
	return err
}

// Update 更新目录的名称、父目录、区域与排序下标，并刷新 updated_at（不改 assistant_id/created_at）。
func (r *TopicFolderRepo) Update(f TopicFolder) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topic_folders SET name = ?, parent_id = ?, zone = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
		f.Name, f.ParentID, f.Zone, f.SortOrder, f.UpdatedAt, f.ID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetParentAndOrder 更新目录的父目录、区域与排序下标（不刷新 updated_at）。
func (r *TopicFolderRepo) SetParentAndOrder(id string, parentID string, zone string, order int) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE topic_folders SET parent_id = ?, zone = ?, sort_order = ? WHERE id = ?`, parentID, zone, order, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Delete 删除目录；子目录与话题的位置调整由调用方负责（不级联删数据）。
func (r *TopicFolderRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM topic_folders WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}
