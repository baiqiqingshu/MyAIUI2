//go:build !windows

package relay

import "os/exec"

// hideConsole 非 Windows 平台无需处理（Python 本身不产生可见窗口）。
func hideConsole(*exec.Cmd) {}
