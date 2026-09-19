// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // 纯 Go SQLite 驱动，注册驱动名 "sqlite"
)

// 数据库文件名与驱动名固定，避免调用方拼路径。
const (
	driverName = "sqlite"
	dbFileName = "app.db"
)

// DB 包装 *sql.DB，统一负责连接参数、迁移与事务。
type DB struct {
	sql *sql.DB
}

// Open 创建数据目录、打开 app.db、设置 WAL/foreign_keys/busy_timeout，并执行 schema 与 user_version 迁移。
func Open(dataDir string) (*DB, error) {
	if dataDir == "" {
		return nil, errors.New("数据目录不能为空")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}

	// _pragma 由驱动在每条新连接上执行，因此无需额外 Ping 前初始化。
	dsn := "file:" + filepath.ToSlash(filepath.Join(dataDir, dbFileName)) +
		"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"

	handle, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	handle.SetMaxOpenConns(4)
	handle.SetMaxIdleConns(4)

	ctx := context.Background()
	if err := handle.PingContext(ctx); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("连接数据库失败: %w", err)
	}
	if err := migrate(ctx, handle); err != nil {
		_ = handle.Close()
		return nil, err
	}
	return &DB{sql: handle}, nil
}

// Close 关闭底层连接。
func (db *DB) Close() error {
	if db == nil || db.sql == nil {
		return nil
	}
	return db.sql.Close()
}

// SQL 返回底层句柄，供 repository 层执行查询与写入。
func (db *DB) SQL() *sql.DB {
	return db.sql
}

// WithTx 在单个事务内执行 fn：fn 返回错误则回滚，否则提交。
func (db *DB) WithTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开启事务失败: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交事务失败: %w", err)
	}
	return nil
}
