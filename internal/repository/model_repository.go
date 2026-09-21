// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/google/uuid"

	"myaiui2/internal/database"
)

// Model 模型记录（synced：远端同步；manual：手动补充）。
type Model struct {
	ID, ProviderID, RemoteID, DisplayName, Modality, CapabilitiesJSON, Source string
	Enabled, MissingRemote                                                    bool
	LastSeenAt                                                                int64
}

// SyncedModel 一次远端同步返回的模型条目（不含本地 id 与开关状态）。
type SyncedModel struct {
	RemoteID, DisplayName, Modality, CapabilitiesJSON string
}

// ModelRepo models 表读写。
type ModelRepo struct {
	db *database.DB
}

// NewModelRepo 构造 ModelRepo。
func NewModelRepo(db *database.DB) *ModelRepo {
	return &ModelRepo{db: db}
}

func scanModel(s rowScanner) (Model, error) {
	var (
		m             Model
		enabled       int64
		missingRemote int64
	)
	if err := s.Scan(&m.ID, &m.ProviderID, &m.RemoteID, &m.DisplayName, &m.Modality, &m.CapabilitiesJSON,
		&m.Source, &enabled, &missingRemote, &m.LastSeenAt); err != nil {
		return Model{}, err
	}
	m.Enabled = enabled != 0
	m.MissingRemote = missingRemote != 0
	return m, nil
}

// normalizeModel 补齐 NOT NULL 列的合理默认值。
func normalizeModel(m Model) Model {
	if m.DisplayName == "" {
		m.DisplayName = m.RemoteID
	}
	if m.Modality == "" {
		m.Modality = "text"
	}
	if m.CapabilitiesJSON == "" {
		m.CapabilitiesJSON = "{}"
	}
	return m
}

// List 返回模型列表；providerID 为空串表示全部，按 provider_id, display_name 排序。
func (r *ModelRepo) List(providerID string) ([]Model, error) {
	var (
		rows *sql.Rows
		err  error
	)
	if providerID == "" {
		rows, err = r.db.SQL().QueryContext(context.Background(), `SELECT id, provider_id, remote_id, display_name, modality, capabilities_json, source, enabled, missing_remote, COALESCE(last_seen_at, 0) FROM models ORDER BY provider_id, display_name, id`)
	} else {
		rows, err = r.db.SQL().QueryContext(context.Background(), `SELECT id, provider_id, remote_id, display_name, modality, capabilities_json, source, enabled, missing_remote, COALESCE(last_seen_at, 0) FROM models WHERE provider_id = ? ORDER BY display_name, id`, providerID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Model, 0, 16)
	for rows.Next() {
		m, err := scanModel(rows)
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

// Get 按 id 读取模型。
func (r *ModelRepo) Get(id string) (Model, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT id, provider_id, remote_id, display_name, modality, capabilities_json, source, enabled, missing_remote, COALESCE(last_seen_at, 0) FROM models WHERE id = ?`, id)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Model{}, ErrNotFound
	}
	if err != nil {
		return Model{}, err
	}
	return m, nil
}

// UpsertSynced 事务内写入同步结果：已存在的 synced 模型更新展示信息，新模型插入且默认未启用；source='manual' 的行不动。
// 返回本次真正插入的模型 ID（按 items 顺序，恒为非 nil 切片）与更新计数。
func (r *ModelRepo) UpsertSynced(providerID string, items []SyncedModel, now int64) ([]string, int, error) {
	addedIDs := make([]string, 0, len(items))
	updated := 0
	err := r.db.WithTx(context.Background(), func(tx *sql.Tx) error {
		for _, item := range items {
			displayName := item.DisplayName
			if displayName == "" {
				displayName = item.RemoteID
			}
			modality := item.Modality
			if modality == "" {
				modality = "text"
			}
			capabilities := item.CapabilitiesJSON
			if capabilities == "" {
				capabilities = "{}"
			}

			res, err := tx.ExecContext(context.Background(), `UPDATE models SET display_name = ?, modality = ?, last_seen_at = ?, missing_remote = 0 WHERE provider_id = ? AND remote_id = ? AND source = 'synced'`,
				displayName, modality, now, providerID, item.RemoteID)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if n > 0 {
				updated++
				continue
			}

			// 没有可更新的 synced 行：可能不存在，也可能被同 remote_id 的 manual 行占用。
			var existing int
			if err := tx.QueryRowContext(context.Background(), `SELECT COUNT(1) FROM models WHERE provider_id = ? AND remote_id = ?`, providerID, item.RemoteID).Scan(&existing); err != nil {
				return err
			}
			if existing > 0 {
				continue
			}

			// 新模型默认未启用（enabled=0），由用户在模型列表中显式勾选。
			id := uuid.NewString()
			if _, err := tx.ExecContext(context.Background(), `INSERT INTO models (id, provider_id, remote_id, display_name, modality, capabilities_json, source, enabled, missing_remote, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 'synced', 0, 0, ?)`,
				id, providerID, item.RemoteID, displayName, modality, capabilities, now); err != nil {
				return err
			}
			addedIDs = append(addedIDs, id)
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return addedIDs, updated, nil
}

// MarkMissing 把本次未返回、且来源为 synced 的模型标记为失联；manual 模型永不改动。
func (r *ModelRepo) MarkMissing(providerID string, seenRemoteIDs []string, now int64) (int, error) {
	_ = now // 失联不清空 last_seen_at，保留最后一次可见时间
	query := `UPDATE models SET missing_remote = 1 WHERE provider_id = ? AND source = 'synced'`
	args := make([]any, 0, len(seenRemoteIDs)+1)
	args = append(args, providerID)
	if len(seenRemoteIDs) > 0 {
		// 仅拼接占位符数量，取值仍走参数绑定。
		placeholders := make([]string, len(seenRemoteIDs))
		for i := range seenRemoteIDs {
			placeholders[i] = "?"
			args = append(args, seenRemoteIDs[i])
		}
		query += " AND remote_id NOT IN (" + strings.Join(placeholders, ", ") + ")"
	}
	res, err := r.db.SQL().ExecContext(context.Background(), query, args...)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// CreateManual 新增手动模型（source 为空时记为 manual）。
func (r *ModelRepo) CreateManual(m Model) error {
	m = normalizeModel(m)
	source := m.Source
	if source == "" {
		source = "manual"
	}
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO models (id, provider_id, remote_id, display_name, modality, capabilities_json, source, enabled, missing_remote, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.ID, m.ProviderID, m.RemoteID, m.DisplayName, m.Modality, m.CapabilitiesJSON, source,
		boolToInt(m.Enabled), boolToInt(m.MissingRemote), m.LastSeenAt)
	return err
}

// Update 更新模型的可编辑字段；source/missing_remote/last_seen_at 保持不变。
func (r *ModelRepo) Update(m Model) error {
	m = normalizeModel(m)
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE models SET remote_id = ?, display_name = ?, modality = ?, capabilities_json = ?, enabled = ? WHERE id = ?`,
		m.RemoteID, m.DisplayName, m.Modality, m.CapabilitiesJSON, boolToInt(m.Enabled), m.ID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetEnabled 设置模型启用状态。
func (r *ModelRepo) SetEnabled(id string, enabled bool) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE models SET enabled = ? WHERE id = ?`, boolToInt(enabled), id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Delete 删除模型。
func (r *ModelRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM models WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// CountByProvider 统计服务商下的模型数。
func (r *ModelRepo) CountByProvider(providerID string) (int, error) {
	var count int
	if err := r.db.SQL().QueryRowContext(context.Background(), `SELECT COUNT(1) FROM models WHERE provider_id = ?`, providerID).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
