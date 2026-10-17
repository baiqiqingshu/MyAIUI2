//go:build windows

package relay

import (
	"os/exec"
	"syscall"
)

// CREATE_NO_WINDOW：不让中转子进程弹出可见的控制台窗口。
// HideWindow 对新控制台生效，CREATE_NO_WINDOW 保证根本不为它分配控制台。
const createNoWindow = 0x08000000

// hideConsole 给子进程挂无窗口属性；Start 之前调用。
func hideConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
