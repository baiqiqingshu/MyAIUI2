// Package relay 管理内嵌 Python 本地中转子进程的生命周期。
//
// 内网环境下 Go 进程直连外网会被系统代理拦截；本包拉起一个只绑定
// 127.0.0.1 的 Python 中转服务，Go 侧受限外发请求改走它出站。
// 不持有任何 Wails 上下文，可独立测试。
package relay

import (
	"bufio"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"myaiui2/internal/logging"
)

//go:embed relay.py
var relayScript []byte

const (
	scriptName      = "relay.py"
	scriptDirName   = "relay"
	readyPrefix     = "RELAY_READY "
	errorPrefix     = "RELAY_ERROR "
	startTimeout    = 30 * time.Second
	stopWaitTimeout = 5 * time.Second
)

// Manager 管理一个 Python 中转子进程；所有方法线程安全。
type Manager struct {
	mu         sync.Mutex
	dataDir    string
	cmd        *exec.Cmd
	done       chan struct{} // 子进程退出（含被 Kill）后由 wait goroutine 关闭
	addr       string        // "127.0.0.1:port"，仅 running 时有效
	running    bool
	pythonPath string
	errText    string
}

// New 创建 Manager；dataDir 为应用数据目录，脚本每次启动覆盖写入 <dataDir>/relay/relay.py。
func New(dataDir string) *Manager {
	return &Manager{dataDir: dataDir}
}

// findPython 依次查找 python / py（-3）/ python3，返回可执行文件与前置参数。
func findPython() (exe string, args []string, err error) {
	if path, lookErr := exec.LookPath("python"); lookErr == nil {
		return path, nil, nil
	}
	if path, lookErr := exec.LookPath("py"); lookErr == nil {
		return path, []string{"-3"}, nil
	}
	if path, lookErr := exec.LookPath("python3"); lookErr == nil {
		return path, nil, nil
	}
	return "", nil, errors.New("未找到 Python 解释器（需要 python 或 py 启动器）")
}

// installScript 把内嵌脚本覆盖写入数据目录，保证版本与二进制一致。
func (m *Manager) installScript() (string, error) {
	dir := filepath.Join(m.dataDir, scriptDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建中转目录失败：%v", err)
	}
	path := filepath.Join(dir, scriptName)
	if err := os.WriteFile(path, relayScript, 0o644); err != nil {
		return "", fmt.Errorf("写入中转脚本失败：%v", err)
	}
	return path, nil
}

// Start 拉起中转子进程并等待 RELAY_READY；已在运行时直接返回 nil。
// 失败时进程已被清理，Addr() 返回空。
func (m *Manager) Start() error {
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return nil
	}
	exe, args, err := findPython()
	if err != nil {
		m.errText = err.Error()
		m.mu.Unlock()
		return err
	}
	script, err := m.installScript()
	if err != nil {
		m.errText = err.Error()
		m.mu.Unlock()
		return err
	}

	cmdArgs := append(append([]string{}, args...), script, "--bind", "127.0.0.1", "--port", "0")
	cmd := exec.Command(exe, cmdArgs...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	hideConsole(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		m.errText = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("创建中转进程管道失败：%v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		m.errText = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("创建中转进程管道失败：%v", err)
	}
	if err := cmd.Start(); err != nil {
		m.errText = err.Error()
		m.mu.Unlock()
		return fmt.Errorf("启动中转进程失败：%v", err)
	}

	done := make(chan struct{})
	ready := make(chan error, 1)
	m.cmd = cmd
	m.done = done
	m.addr = ""
	m.running = false
	m.pythonPath = exe
	m.errText = ""
	go m.readStdout(stdout, ready)
	go m.drainStderr(stderr)
	go m.waitExit(cmd, done)
	m.mu.Unlock()

	select {
	case err := <-ready:
		return err
	case <-time.After(startTimeout):
		m.mu.Lock()
		m.errText = "中转服务启动超时"
		m.mu.Unlock()
		m.Stop()
		return errors.New("中转服务启动超时")
	}
}

// Stop 结束中转子进程并等待回收；未运行时为无操作。
func (m *Manager) Stop() {
	m.mu.Lock()
	cmd := m.cmd
	done := m.done
	m.cmd = nil
	m.done = nil
	m.running = false
	m.addr = ""
	m.mu.Unlock()

	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Kill(); err != nil {
			logging.Infof("结束中转进程失败（可能已退出）: %v", err)
		}
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(stopWaitTimeout):
			logging.Errorf("等待中转进程退出超时")
		}
	}
}

// Addr 返回中转基址（如 http://127.0.0.1:52341）；未运行返回 ""。
func (m *Manager) Addr() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.running || m.addr == "" {
		return ""
	}
	return "http://" + m.addr
}

// Status 返回运行状态快照；addr 为 http:// 前缀形式（未运行为空）。
func (m *Manager) Status() (running bool, addr string, pythonPath string, errText string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	base := ""
	if m.running && m.addr != "" {
		base = "http://" + m.addr
	}
	return m.running, base, m.pythonPath, m.errText
}

// readStdout 读取子进程 stdout：首行 RELAY_READY/RELAY_ERROR 决定启动结果，
// 其余行记日志；EOF 且尚未报告就绪时按启动失败处理。
func (m *Manager) readStdout(r io.Reader, ready chan<- error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	reported := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case strings.HasPrefix(line, readyPrefix):
			addr := strings.TrimSpace(strings.TrimPrefix(line, readyPrefix))
			m.mu.Lock()
			m.addr = addr
			m.running = true
			m.mu.Unlock()
			if !reported {
				reported = true
				ready <- nil
			}
		case strings.HasPrefix(line, errorPrefix):
			errText := strings.TrimSpace(strings.TrimPrefix(line, errorPrefix))
			m.mu.Lock()
			m.errText = errText
			m.mu.Unlock()
			if !reported {
				reported = true
				ready <- fmt.Errorf("中转服务启动失败：%s", errText)
			}
		default:
			if line != "" {
				logging.Infof("relay: %s", line)
			}
		}
	}
	if !reported {
		m.mu.Lock()
		if m.errText == "" {
			m.errText = "中转进程未报告就绪状态"
		}
		errText := m.errText
		m.mu.Unlock()
		ready <- fmt.Errorf("中转服务启动失败：%s", errText)
	}
}

// drainStderr 把子进程 stderr 逐行记入日志（Python 异常/告警）。
func (m *Manager) drainStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			logging.Errorf("relay stderr: %s", line)
		}
	}
}

// waitExit 回收子进程；非主动 Stop 的退出会把状态置为未运行。
func (m *Manager) waitExit(cmd *exec.Cmd, done chan struct{}) {
	defer close(done)
	if err := cmd.Wait(); err != nil {
		logging.Infof("中转进程退出: %v", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == cmd {
		m.cmd = nil
		m.done = nil
		m.running = false
		m.addr = ""
		if m.errText == "" {
			m.errText = "中转进程已退出"
		}
	}
}
