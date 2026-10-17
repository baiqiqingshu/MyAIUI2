// MyAIUI2 原创实现（未复制上游 Cherry Studio 代码）。
package database

import (
	"context"
	"database/sql"
	_ "embed"
	"fmt"
	"strings"
)

//go:embed schema.sql
var schemaSQL string

//go:embed migration_v2.sql
var migrationV2SQL string

//go:embed migration_v3.sql
var migrationV3SQL string

// schemaVersion 当前 schema 版本（PRAGMA user_version 目标值）。
const schemaVersion = 3

// migrate 幂等执行 schema：版本已达标直接返回，否则在单事务内执行建表或增量迁移并写入版本号。
func migrate(ctx context.Context, handle *sql.DB) error {
	version, err := userVersion(ctx, handle)
	if err != nil {
		return err
	}
	if version >= schemaVersion {
		return nil
	}

	tx, err := handle.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开启数据库迁移事务失败: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// user_version 为 0 说明是全新库，schema.sql 已是最新结构；否则按版本逐级增量升级。
	if version < 1 {
		if err := execScript(ctx, tx, schemaSQL, "初始化数据库结构失败"); err != nil {
			return err
		}
	} else {
		// 按版本逐级增量升级：v1 库会顺序跑完 v2、v3 两个迁移脚本。
		if version < 2 {
			if err := execScript(ctx, tx, migrationV2SQL, "升级数据库结构到 v2 失败"); err != nil {
				return err
			}
		}
		if version < 3 {
			if err := execScript(ctx, tx, migrationV3SQL, "升级数据库结构到 v3 失败"); err != nil {
				return err
			}
		}
	}
	// user_version 不支持参数占位符，此处只拼接编译期常量。
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("写入 schema 版本失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交数据库迁移失败: %w", err)
	}
	return nil
}

// execScript 逐条执行脚本中的单语句（注释行已由 splitStatements 剥离）。
func execScript(ctx context.Context, tx *sql.Tx, script string, prefix string) error {
	for _, stmt := range splitStatements(script) {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("%s: %w", prefix, err)
		}
	}
	return nil
}

// userVersion 读取当前 schema 版本。
func userVersion(ctx context.Context, handle *sql.DB) (int, error) {
	var version int
	if err := handle.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return 0, fmt.Errorf("读取 schema 版本失败: %w", err)
	}
	return version, nil
}

// splitStatements 去掉注释行后按分号拆分为单条语句。
func splitStatements(script string) []string {
	kept := make([]string, 0, 16)
	for _, line := range strings.Split(script, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		kept = append(kept, line)
	}
	statements := make([]string, 0, 16)
	for _, raw := range strings.Split(strings.Join(kept, "\n"), ";") {
		if stmt := strings.TrimSpace(raw); stmt != "" {
			statements = append(statements, stmt)
		}
	}
	return statements
}
