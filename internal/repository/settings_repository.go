// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// SettingsRepo settings 表读写（值一律为 JSON 文本）。
type SettingsRepo struct {
	db *database.DB
}

// NewSettingsRepo 构造 SettingsRepo。
func NewSettingsRepo(db *database.DB) *SettingsRepo {
	return &SettingsRepo{db: db}
}

// Get 读取单个设置项；不存在时返回 found=false 且无错误。
func (r *SettingsRepo) Get(key string) (string, bool, error) {
	var value string
	err := r.db.SQL().QueryRowContext(context.Background(), `SELECT value_json FROM settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// Set 写入或覆盖单个设置项。
func (r *SettingsRepo) Set(key string, valueJSON string, now int64) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, valueJSON, now)
	return err
}

// All 返回全部设置项。
func (r *SettingsRepo) All() (map[string]string, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT key, value_json FROM settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	all := make(map[string]string, 8)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		all[key] = value
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return all, nil
}
