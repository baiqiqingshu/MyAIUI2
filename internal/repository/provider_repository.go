// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// ErrNotFound 记录不存在。
var ErrNotFound = errors.New("记录不存在")

// ---------------------------------------------------------------- 包内共享小工具

// rowScanner 统一 *sql.Row 与 *sql.Rows 的扫描入口。
type rowScanner interface {
	Scan(dest ...any) error
}

func boolToInt(v bool) int64 {
	if v {
		return 1
	}
	return 0
}

// nilIfEmpty 空串按 NULL 存储（外键列与可选列需要）。
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nilIfEmptyBytes 空字节按 NULL 存储（密钥密文）。
func nilIfEmptyBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

// temperatureValue 未显式设置温度时存 NULL，避免把 0 误当作显式值。
func temperatureValue(value float64, set bool) any {
	if !set {
		return nil
	}
	return value
}

// ---------------------------------------------------------------- Provider

// Provider 模型服务商记录。
type Provider struct {
	ID, Name, Kind, BaseURL string
	APIKeyCipher            []byte
	Enabled                 bool
	ModelPath               string
	CreatedAt, UpdatedAt    int64
	LastSyncAt              int64
	LastSyncError           string
}

// ProviderRepo providers 表读写。
type ProviderRepo struct {
	db *database.DB
}

// NewProviderRepo 构造 ProviderRepo。
func NewProviderRepo(db *database.DB) *ProviderRepo {
	return &ProviderRepo{db: db}
}

func scanProvider(s rowScanner) (Provider, error) {
	var (
		p       Provider
		cipher  []byte
		enabled int64
	)
	if err := s.Scan(&p.ID, &p.Name, &p.Kind, &p.BaseURL, &cipher, &enabled, &p.ModelPath,
		&p.CreatedAt, &p.UpdatedAt, &p.LastSyncAt, &p.LastSyncError); err != nil {
		return Provider{}, err
	}
	p.APIKeyCipher = cipher
	p.Enabled = enabled != 0
	return p, nil
}

// List 返回全部服务商。
func (r *ProviderRepo) List() ([]Provider, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT id, name, kind, base_url, api_key_cipher, enabled, model_path, created_at, updated_at, COALESCE(last_sync_at, 0), COALESCE(last_sync_error, '') FROM providers ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Provider, 0, 8)
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// Get 按 id 读取服务商。
func (r *ProviderRepo) Get(id string) (Provider, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT id, name, kind, base_url, api_key_cipher, enabled, model_path, created_at, updated_at, COALESCE(last_sync_at, 0), COALESCE(last_sync_error, '') FROM providers WHERE id = ?`, id)
	p, err := scanProvider(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Provider{}, ErrNotFound
	}
	if err != nil {
		return Provider{}, err
	}
	return p, nil
}

// Create 新增服务商。
func (r *ProviderRepo) Create(p Provider) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO providers (id, name, kind, base_url, api_key_cipher, enabled, model_path, created_at, updated_at, last_sync_at, last_sync_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.Kind, p.BaseURL, nilIfEmptyBytes(p.APIKeyCipher), boolToInt(p.Enabled), p.ModelPath,
		p.CreatedAt, p.UpdatedAt, p.LastSyncAt, p.LastSyncError)
	return err
}

// Update 更新服务商的可编辑字段；同步状态字段由 SetSyncResult 维护。
func (r *ProviderRepo) Update(p Provider) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE providers SET name = ?, kind = ?, base_url = ?, api_key_cipher = ?, enabled = ?, model_path = ?, updated_at = ? WHERE id = ?`,
		p.Name, p.Kind, p.BaseURL, nilIfEmptyBytes(p.APIKeyCipher), boolToInt(p.Enabled), p.ModelPath, p.UpdatedAt, p.ID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Delete 删除服务商（其模型级联删除）。
func (r *ProviderRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM providers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// SetSyncResult 记录最近一次同步的结果。
func (r *ProviderRepo) SetSyncResult(id string, at int64, errMsg string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE providers SET last_sync_at = ?, last_sync_error = ? WHERE id = ?`, at, errMsg, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// CountModels 统计服务商下的模型数。
func (r *ProviderRepo) CountModels(providerID string) (int, error) {
	var count int
	if err := r.db.SQL().QueryRowContext(context.Background(), `SELECT COUNT(1) FROM models WHERE provider_id = ?`, providerID).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// requireAffected 行数为 0 时返回 ErrNotFound。
func requireAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
