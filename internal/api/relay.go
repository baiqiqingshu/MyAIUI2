package api

import (
	"encoding/json"
	"errors"
	"strings"

	"myaiui2/internal/logging"
	"myaiui2/internal/relay"
)

// settingsKeyRelay 是 settings 表里中转配置的键，值为 {"Enabled":bool}。
const settingsKeyRelay = "relay"

// RelayStatusDTO 本地 Python 中转服务状态（设置页展示 + 开关返回值）。
type RelayStatusDTO struct {
	Enabled    bool
	Running    bool
	Addr       string // 例 http://127.0.0.1:52341，未运行为空
	PythonPath string
	Error      string
}

// storedRelaySettings 是写入 settings 表的中转配置。
type storedRelaySettings struct {
	Enabled bool
}

// relayManager 返回中转进程管理器（可能为 nil：数据目录定位失败时未创建）。
func (a *AppAPI) relayManager() *relay.Manager {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.relay
}

// relayEnabled 读取中转开关；缺省或解析失败按默认开启处理。
func (a *AppAPI) relayEnabled() (bool, error) {
	raw, ok, err := a.settings.Get(settingsKeyRelay)
	if err != nil {
		return true, wrapRepoErr("读取中转设置失败", "", err)
	}
	if ok && strings.TrimSpace(raw) != "" {
		var stored storedRelaySettings
		if err := json.Unmarshal([]byte(raw), &stored); err == nil {
			return stored.Enabled, nil
		}
	}
	return true, nil
}

// relayStatus 由设置开关与进程状态合成 DTO。
func (a *AppAPI) relayStatus(enabled bool) RelayStatusDTO {
	dto := RelayStatusDTO{Enabled: enabled}
	if mgr := a.relayManager(); mgr != nil {
		running, addr, pythonPath, errText := mgr.Status()
		dto.Running = running
		dto.Addr = addr
		dto.PythonPath = pythonPath
		if dto.Error == "" {
			dto.Error = errText
		}
	}
	return dto
}

// startRelay 拉起中转子进程并把受限网络桥切到中转地址；失败时 bridge 保持直连。
func (a *AppAPI) startRelay() error {
	mgr := a.relayManager()
	if mgr == nil {
		return errors.New("中转服务未初始化")
	}
	if err := mgr.Start(); err != nil {
		a.bridge.SetRelay("")
		return err
	}
	a.bridge.SetRelay(mgr.Addr())
	logging.Infof("本地中转已启用：%s", mgr.Addr())
	return nil
}

// stopRelay 断开 bridge 的中转指向并结束子进程。
func (a *AppAPI) stopRelay() {
	a.bridge.SetRelay("")
	if mgr := a.relayManager(); mgr != nil {
		mgr.Stop()
	}
}

// GetRelayStatus 返回中转开关与运行状态。
func (a *AppAPI) GetRelayStatus() (RelayStatusDTO, error) {
	if err := a.ready(); err != nil {
		return RelayStatusDTO{}, err
	}
	enabled, err := a.relayEnabled()
	if err != nil {
		return RelayStatusDTO{}, err
	}
	return a.relayStatus(enabled), nil
}

// SetRelayEnabled 持久化中转开关并即时生效；
// Enabled 始终按用户意图保存，启动失败只在 Error 字段说明。
func (a *AppAPI) SetRelayEnabled(enabled bool) (RelayStatusDTO, error) {
	if err := a.ready(); err != nil {
		return RelayStatusDTO{}, err
	}
	raw, err := json.Marshal(storedRelaySettings{Enabled: enabled})
	if err != nil {
		return RelayStatusDTO{}, errors.New("中转设置序列化失败")
	}
	if err := a.settings.Set(settingsKeyRelay, string(raw), nowMs()); err != nil {
		return RelayStatusDTO{}, wrapRepoErr("保存中转设置失败", "", err)
	}

	var startErr error
	if enabled {
		startErr = a.startRelay()
		if startErr != nil {
			logging.Errorf("启动本地中转失败: %v", startErr)
		}
	} else {
		a.stopRelay()
	}
	dto := a.relayStatus(enabled)
	if startErr != nil {
		dto.Error = trimErrText(startErr.Error())
	}
	return dto, nil
}
