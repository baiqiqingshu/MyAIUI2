// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package repository

import (
	"context"
	"database/sql"
	"errors"

	"myaiui2/internal/database"
)

// Assistant 助手配置记录。
type Assistant struct {
	ID, Name, Emoji, SystemPrompt, ProviderID, ModelID string
	Temperature                                        float64
	TemperatureSet                                     bool
	WebSearchDefault                                   bool
	SortOrder                                          int
	CreatedAt, UpdatedAt                               int64
}

// AssistantRepo assistants 表读写。
type AssistantRepo struct {
	db *database.DB
}

// NewAssistantRepo 构造 AssistantRepo。
func NewAssistantRepo(db *database.DB) *AssistantRepo {
	return &AssistantRepo{db: db}
}

func scanAssistant(s rowScanner) (Assistant, error) {
	var (
		a           Assistant
		temperature sql.NullFloat64
		webSearch   int64
	)
	if err := s.Scan(&a.ID, &a.Name, &a.Emoji, &a.SystemPrompt, &a.ProviderID, &a.ModelID, &temperature,
		&webSearch, &a.SortOrder, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return Assistant{}, err
	}
	if temperature.Valid {
		a.Temperature = temperature.Float64
		a.TemperatureSet = true
	}
	a.WebSearchDefault = webSearch != 0
	return a, nil
}

// List 返回全部助手，按 sort_order, created_at 排序。
func (r *AssistantRepo) List() ([]Assistant, error) {
	rows, err := r.db.SQL().QueryContext(context.Background(), `SELECT id, name, emoji, system_prompt, COALESCE(provider_id, ''), COALESCE(model_id, ''), temperature, web_search_default, sort_order, created_at, updated_at FROM assistants ORDER BY sort_order, created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Assistant, 0, 8)
	for rows.Next() {
		a, err := scanAssistant(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// Get 按 id 读取助手。
func (r *AssistantRepo) Get(id string) (Assistant, error) {
	row := r.db.SQL().QueryRowContext(context.Background(), `SELECT id, name, emoji, system_prompt, COALESCE(provider_id, ''), COALESCE(model_id, ''), temperature, web_search_default, sort_order, created_at, updated_at FROM assistants WHERE id = ?`, id)
	a, err := scanAssistant(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Assistant{}, ErrNotFound
	}
	if err != nil {
		return Assistant{}, err
	}
	return a, nil
}

// Create 新增助手。
func (r *AssistantRepo) Create(a Assistant) error {
	_, err := r.db.SQL().ExecContext(context.Background(), `INSERT INTO assistants (id, name, emoji, system_prompt, provider_id, model_id, temperature, web_search_default, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		a.ID, a.Name, a.Emoji, a.SystemPrompt, nilIfEmpty(a.ProviderID), nilIfEmpty(a.ModelID),
		temperatureValue(a.Temperature, a.TemperatureSet), boolToInt(a.WebSearchDefault), a.SortOrder, a.CreatedAt, a.UpdatedAt)
	return err
}

// Update 更新助手（不改 created_at）。
func (r *AssistantRepo) Update(a Assistant) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `UPDATE assistants SET name = ?, emoji = ?, system_prompt = ?, provider_id = ?, model_id = ?, temperature = ?, web_search_default = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
		a.Name, a.Emoji, a.SystemPrompt, nilIfEmpty(a.ProviderID), nilIfEmpty(a.ModelID),
		temperatureValue(a.Temperature, a.TemperatureSet), boolToInt(a.WebSearchDefault), a.SortOrder, a.UpdatedAt, a.ID)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Delete 删除助手（其话题级联删除）。
func (r *AssistantRepo) Delete(id string) error {
	res, err := r.db.SQL().ExecContext(context.Background(), `DELETE FROM assistants WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(res)
}

// Count 统计助手数量。
func (r *AssistantRepo) Count() (int, error) {
	var count int
	if err := r.db.SQL().QueryRowContext(context.Background(), `SELECT COUNT(1) FROM assistants`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}
