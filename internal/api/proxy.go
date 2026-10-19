package api

import (
	"encoding/json"
	"errors"
	"net/url"

	"myaiui2/internal/transport"
)

const settingsKeyProxy = "network_proxy"

// ProxySettingsDTO 空 URL 表示不使用代理；内网场景固定关闭证书校验。
type ProxySettingsDTO struct {
	URL       string
	VerifySSL bool
}

type SaveProxySettingsDTO struct {
	URL string
}

type storedProxySettings struct {
	URL       string `json:",omitempty"`
	URLCipher []byte `json:",omitempty"`
}

func (a *AppAPI) loadProxySettings() (ProxySettingsDTO, error) {
	raw, found, err := a.settings.Get(settingsKeyProxy)
	if err != nil {
		return ProxySettingsDTO{}, wrapRepoErr("读取代理设置失败", "", err)
	}
	if !found {
		return ProxySettingsDTO{}, nil
	}
	var stored storedProxySettings
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		return ProxySettingsDTO{}, errors.New("代理设置格式错误")
	}
	if len(stored.URLCipher) > 0 {
		stored.URL, err = a.secrets.Decrypt(stored.URLCipher)
		if err != nil {
			return ProxySettingsDTO{}, errors.New("代理凭据解密失败")
		}
	}
	normalized, err := transport.NormalizeProxyURL(stored.URL)
	if err != nil {
		return ProxySettingsDTO{}, err
	}
	return ProxySettingsDTO{URL: normalized, VerifySSL: false}, nil
}

func (a *AppAPI) restoreProxy() error {
	a.proxyMu.Lock()
	defer a.proxyMu.Unlock()
	settings, err := a.loadProxySettings()
	if err != nil {
		return err
	}
	return a.bridge.SetProxy(settings.URL)
}

func (a *AppAPI) GetProxySettings() (ProxySettingsDTO, error) {
	if err := a.ready(); err != nil {
		return ProxySettingsDTO{}, err
	}
	a.proxyMu.Lock()
	defer a.proxyMu.Unlock()
	return a.loadProxySettings()
}

// SaveProxySettings 保存并即时生效；留空禁用，含凭据的地址通过 DPAPI 加密后入库。
func (a *AppAPI) SaveProxySettings(input SaveProxySettingsDTO) (ProxySettingsDTO, error) {
	if err := a.ready(); err != nil {
		return ProxySettingsDTO{}, err
	}
	normalized, err := transport.NormalizeProxyURL(input.URL)
	if err != nil {
		return ProxySettingsDTO{}, err
	}
	a.proxyMu.Lock()
	defer a.proxyMu.Unlock()
	stored := storedProxySettings{URL: normalized}
	if parsed, _ := url.Parse(normalized); parsed != nil && parsed.User != nil {
		stored.URLCipher, err = a.secrets.Encrypt(normalized)
		if err != nil {
			return ProxySettingsDTO{}, errors.New("代理凭据加密失败")
		}
		stored.URL = ""
	}
	raw, err := json.Marshal(stored)
	if err != nil {
		return ProxySettingsDTO{}, errors.New("代理设置序列化失败")
	}
	if err := a.settings.Set(settingsKeyProxy, string(raw), nowMs()); err != nil {
		return ProxySettingsDTO{}, wrapRepoErr("保存代理设置失败", "", err)
	}
	if err := a.bridge.SetProxy(normalized); err != nil {
		return ProxySettingsDTO{}, err
	}
	return ProxySettingsDTO{URL: normalized, VerifySSL: false}, nil
}
