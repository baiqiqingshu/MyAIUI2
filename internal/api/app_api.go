package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"myaiui2/internal/database"
	"myaiui2/internal/logging"
	"myaiui2/internal/platform"
	"myaiui2/internal/repository"
	"myaiui2/internal/secret"
	"myaiui2/internal/transport"
)

const (
	dataDirName = "MyAIUI2"
	dataDirLeaf = "data"

	settingsKeyApp       = "app"
	settingsKeySearch    = "search"
	settingsKeySearchKey = "search_api_key_cipher"

	defaultProviderKind   = "openai-compatible"
	defaultModelPath      = "/models"
	defaultAssistantName  = "默认助手"
	defaultAssistantEmoji = "🤖"
	defaultTopicTitle     = "新话题"
	defaultSearchService  = "searxng"
	defaultMaxResults     = 5
	maxSearchResults      = 10

	// 分支树节点摘要：过大的 parts_json（可能内嵌 base64 图片）直接放弃解析。
	previewPartsBytes = 64 << 10
	previewRuneLimit  = 60

	testProviderTimeout = 10 * time.Second
	syncModelsTimeout   = 30 * time.Second
	maxRequestTimeoutMs = 10 * 60 * 1000
	maxRequestBodyBytes = 16 << 20
	maxInternalBytes    = 8 << 20
	errorTextLimit      = 300
	maxQueryLen         = 500
)

// AppAPI 是 Wails 绑定的唯一门面：聚合数据库、仓库、密钥存储与受限网络桥。
// 除契约 §2.7 列出的方法外不额外导出方法（绑定只依赖这些方法）。
type AppAPI struct {
	mu       sync.Mutex
	ctx      context.Context
	db       *database.DB
	started  bool
	startErr error

	providers  *repository.ProviderRepo
	models     *repository.ModelRepo
	assistants *repository.AssistantRepo
	topics     *repository.TopicRepo
	messages   *repository.MessageRepo
	settings   *repository.SettingsRepo

	secrets secret.Store
	bridge  *transport.Bridge

	// fetches 收集内部同步请求（模型列表/连通性检测）的事件结果，键为 RequestID。
	fetches map[string]*syncFetch
}

// syncFetch 聚合一次内部同步请求的事件流；终止于 end 或 error。
type syncFetch struct {
	status     int
	statusText string
	body       []byte
	errMsg     string
	done       chan struct{}
	once       sync.Once
}

func (f *syncFetch) finish() {
	f.once.Do(func() { close(f.done) })
}

// internalResponse 内部同步请求的结果快照。
type internalResponse struct {
	status     int
	statusText string
	body       []byte
}

// NewAppAPI 创建门面；数据库在 Start 时打开。
func NewAppAPI() *AppAPI {
	a := &AppAPI{
		secrets: secret.New(),
		fetches: make(map[string]*syncFetch),
	}
	a.bridge = transport.NewBridge(a.emit)
	return a
}

// emit 由 transport.Bridge 回调：内部请求就地收集，其余事件转发给前端。
func (a *AppAPI) emit(event string, payload any) {
	if a.deliverInternal(payload) {
		return
	}
	ctx := a.wailsContext()
	if ctx == nil || ctx.Value("events") == nil {
		// 非 Wails 生命周期上下文（工具/脚本调用）直接丢弃事件：
		// runtime.EventsEmit 在拿不到 events 时会 log.Fatalf 终止进程。
		return
	}
	runtime.EventsEmit(ctx, event, payload)
}

// Start 打开数据库、恢复被中断的生成消息并缓存 Wails 上下文；重复调用无副作用。
func (a *AppAPI) Start(ctx context.Context) error {
	a.mu.Lock()
	if a.started {
		a.mu.Unlock()
		return nil
	}
	a.ctx = ctx
	a.started = true
	a.mu.Unlock()

	if err := a.openDatabase(); err != nil {
		a.mu.Lock()
		a.startErr = err
		a.mu.Unlock()
		logging.Errorf("启动初始化失败: %v", err)
		return err
	}

	now := nowMs()
	if n, err := a.messages.MarkStreamingAsInterrupted(now); err != nil {
		logging.Errorf("标记中断消息失败: %v", err)
	} else if n > 0 {
		logging.Infof("已把 %d 条未完成的生成消息标记为 interrupted", n)
	}
	return nil
}

// Stop 关闭数据库连接；数据目录与密钥保持不变。
func (a *AppAPI) Stop(ctx context.Context) {
	a.mu.Lock()
	db := a.db
	a.db = nil
	a.started = false
	a.mu.Unlock()
	if db == nil {
		return
	}
	if err := db.Close(); err != nil {
		logging.Errorf("关闭数据库失败: %v", err)
	}
}

func (a *AppAPI) openDatabase() error {
	dir, err := dataDir()
	if err != nil {
		return fmt.Errorf("定位数据目录失败：%v", err)
	}
	db, err := database.Open(dir)
	if err != nil {
		return fmt.Errorf("打开本地数据库失败：%v", err)
	}
	a.db = db
	a.providers = repository.NewProviderRepo(db)
	a.models = repository.NewModelRepo(db)
	a.assistants = repository.NewAssistantRepo(db)
	a.topics = repository.NewTopicRepo(db)
	a.messages = repository.NewMessageRepo(db)
	a.settings = repository.NewSettingsRepo(db)
	return nil
}

// dataDir 返回 %LOCALAPPDATA%\MyAIUI2\data（非 Windows 回退到用户配置目录）。
func dataDir() (string, error) {
	base := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
	if base == "" {
		if dir, err := os.UserConfigDir(); err == nil {
			base = dir
		}
	}
	if base == "" {
		return "", errors.New("无法确定本地数据目录")
	}
	return filepath.Join(base, dataDirName, dataDirLeaf), nil
}

func (a *AppAPI) wailsContext() context.Context {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.ctx
}

// baseContext 用于 Go 侧发起的网络调用：Wails 上下文缺失时回退到 Background。
func (a *AppAPI) baseContext() context.Context {
	if ctx := a.wailsContext(); ctx != nil {
		return ctx
	}
	return context.Background()
}

// ready 校验应用已成功初始化；启动失败时返回致命错误（前端展示错误页）。
func (a *AppAPI) ready() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.startErr != nil {
		return fmt.Errorf("应用初始化失败：%v", a.startErr)
	}
	if !a.started || a.db == nil {
		return errors.New("应用尚未初始化")
	}
	return nil
}

// ---------------------------------------------------------------- bootstrap

// Bootstrap 返回首屏数据，并保证默认助手与至少一个话题存在。
func (a *AppAPI) Bootstrap() (BootstrapDTO, error) {
	if err := a.ready(); err != nil {
		return BootstrapDTO{}, err
	}
	assistants, err := a.ensureDefaultAssistant()
	if err != nil {
		return BootstrapDTO{}, err
	}
	settings, err := a.loadAppSettings()
	if err != nil {
		return BootstrapDTO{}, err
	}
	activeAssistantID := pickAssistantID(assistants, settings.ActiveAssistantID)
	topics, err := a.ensureTopics(activeAssistantID)
	if err != nil {
		return BootstrapDTO{}, err
	}
	activeTopicID := pickTopicID(topics, settings.ActiveTopicID)
	if settings.ActiveAssistantID != activeAssistantID || settings.ActiveTopicID != activeTopicID {
		settings.ActiveAssistantID = activeAssistantID
		settings.ActiveTopicID = activeTopicID
		if err := a.saveAppSettings(settings); err != nil {
			logging.Errorf("保存应用设置失败: %v", err)
		}
	}
	providers, err := a.listProviders()
	if err != nil {
		return BootstrapDTO{}, err
	}
	models, err := a.listModels("")
	if err != nil {
		return BootstrapDTO{}, err
	}
	search, err := a.getSearchSettings()
	if err != nil {
		return BootstrapDTO{}, err
	}
	return BootstrapDTO{
		AppName:    AppName,
		Version:    AppVersion,
		Settings:   settings,
		Assistants: assistants,
		Providers:  providers,
		Models:     models,
		Topics:     topics,
		Search:     search,
	}, nil
}

func (a *AppAPI) ensureDefaultAssistant() ([]AssistantDTO, error) {
	list, err := a.assistants.List()
	if err != nil {
		return nil, wrapRepoErr("读取助手失败", "", err)
	}
	if len(list) == 0 {
		if _, err := a.createDefaultAssistant(0); err != nil {
			return nil, err
		}
		if list, err = a.assistants.List(); err != nil {
			return nil, wrapRepoErr("读取助手失败", "", err)
		}
	}
	out := make([]AssistantDTO, 0, len(list))
	for _, item := range list {
		out = append(out, toAssistantDTO(item))
	}
	return out, nil
}

func (a *AppAPI) createDefaultAssistant(sortOrder int) (repository.Assistant, error) {
	now := nowMs()
	assistant := repository.Assistant{
		ID:        uuid.NewString(),
		Name:      defaultAssistantName,
		Emoji:     defaultAssistantEmoji,
		SortOrder: sortOrder,
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := a.assistants.Create(assistant); err != nil {
		return repository.Assistant{}, wrapRepoErr("创建默认助手失败", "", err)
	}
	return assistant, nil
}

func (a *AppAPI) ensureTopics(assistantID string) ([]TopicDTO, error) {
	topics, err := a.listTopics(assistantID)
	if err != nil {
		return nil, err
	}
	if len(topics) > 0 {
		return topics, nil
	}
	if _, err := a.createTopic(assistantID, defaultTopicTitle); err != nil {
		return nil, err
	}
	return a.listTopics(assistantID)
}

func (a *AppAPI) createTopic(assistantID, title string) (repository.Topic, error) {
	now := nowMs()
	topic := repository.Topic{
		ID:          uuid.NewString(),
		AssistantID: assistantID,
		Title:       title,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := a.topics.Create(topic); err != nil {
		return repository.Topic{}, wrapRepoErr("创建话题失败", "", err)
	}
	return topic, nil
}

func (a *AppAPI) loadAppSettings() (AppSettingsDTO, error) {
	settings := AppSettingsDTO{Theme: "system"}
	raw, ok, err := a.settings.Get(settingsKeyApp)
	if err != nil {
		return settings, wrapRepoErr("读取应用设置失败", "", err)
	}
	if ok && strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &settings); err != nil {
			settings = AppSettingsDTO{Theme: "system"}
		}
	}
	if settings.Theme == "" {
		settings.Theme = "system"
	}
	return settings, nil
}

func (a *AppAPI) saveAppSettings(settings AppSettingsDTO) error {
	raw, err := json.Marshal(settings)
	if err != nil {
		return errors.New("应用设置序列化失败")
	}
	if err := a.settings.Set(settingsKeyApp, string(raw), nowMs()); err != nil {
		return wrapRepoErr("保存应用设置失败", "", err)
	}
	return nil
}

// ---------------------------------------------------------------- providers

func (a *AppAPI) ListProviders() ([]ProviderDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.listProviders()
}

func (a *AppAPI) listProviders() ([]ProviderDTO, error) {
	list, err := a.providers.List()
	if err != nil {
		return nil, wrapRepoErr("读取模型服务失败", "", err)
	}
	out := make([]ProviderDTO, 0, len(list))
	for _, item := range list {
		out = append(out, a.toProviderDTO(item))
	}
	return out, nil
}

func (a *AppAPI) toProviderDTO(p repository.Provider) ProviderDTO {
	count, err := a.providers.CountModels(p.ID)
	if err != nil {
		count = 0
	}
	return ProviderDTO{
		ID:            p.ID,
		Name:          p.Name,
		Kind:          p.Kind,
		BaseURL:       p.BaseURL,
		Enabled:       p.Enabled,
		ModelPath:     p.ModelPath,
		HasAPIKey:     len(p.APIKeyCipher) > 0,
		CreatedAt:     p.CreatedAt,
		UpdatedAt:     p.UpdatedAt,
		LastSyncAt:    p.LastSyncAt,
		LastSyncError: p.LastSyncError,
		ModelCount:    count,
	}
}

// SaveProvider 新建或更新模型服务；密钥只在非空时覆盖，ClearAPIKey 时清空。
func (a *AppAPI) SaveProvider(input SaveProviderDTO) (ProviderDTO, error) {
	if err := a.ready(); err != nil {
		return ProviderDTO{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return ProviderDTO{}, errors.New("服务名称不能为空")
	}
	if err := validateTextLen("服务名称", name, maxNameLen); err != nil {
		return ProviderDTO{}, err
	}
	kind := strings.TrimSpace(input.Kind)
	if kind == "" {
		kind = defaultProviderKind
	}
	if err := validateEnum("服务类型", kind, providerKinds); err != nil {
		return ProviderDTO{}, err
	}
	baseURL, err := normalizeBaseURL(input.BaseURL)
	if err != nil {
		return ProviderDTO{}, err
	}
	modelPath := strings.TrimSpace(input.ModelPath)
	if modelPath == "" {
		modelPath = defaultModelPath
	}
	modelPath = ensureLeadingSlash(modelPath)
	if err := validateRelativePath("模型列表路径", modelPath); err != nil {
		return ProviderDTO{}, err
	}

	now := nowMs()
	var provider repository.Provider
	creating := strings.TrimSpace(input.ID) == ""
	if creating {
		provider = repository.Provider{ID: uuid.NewString(), CreatedAt: now}
	} else {
		if err := validateUUID("模型服务 ID", input.ID); err != nil {
			return ProviderDTO{}, err
		}
		existing, err := a.providers.Get(strings.TrimSpace(input.ID))
		if err != nil {
			return ProviderDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
		}
		provider = existing
	}
	provider.Name = name
	provider.Kind = kind
	provider.BaseURL = baseURL
	provider.ModelPath = modelPath
	provider.Enabled = input.Enabled
	provider.UpdatedAt = now

	switch {
	case input.ClearAPIKey:
		provider.APIKeyCipher = nil
	case strings.TrimSpace(input.APIKey) != "":
		cipher, err := a.secrets.Encrypt(input.APIKey)
		if err != nil {
			return ProviderDTO{}, errors.New("密钥加密失败")
		}
		provider.APIKeyCipher = cipher
	}

	if creating {
		if err := a.providers.Create(provider); err != nil {
			return ProviderDTO{}, wrapRepoErr("保存模型服务失败", "", err)
		}
	} else if err := a.providers.Update(provider); err != nil {
		return ProviderDTO{}, wrapRepoErr("保存模型服务失败", "模型服务不存在", err)
	}
	return a.toProviderDTO(provider), nil
}

func (a *AppAPI) DeleteProvider(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("模型服务 ID", id); err != nil {
		return err
	}
	providerID := strings.TrimSpace(id)
	if err := a.clearAssistantReferences(providerID, true); err != nil {
		return err
	}
	if err := a.providers.Delete(providerID); err != nil {
		return wrapRepoErr("删除模型服务失败", "模型服务不存在", err)
	}
	return nil
}

// clearAssistantReferences 在删除服务/模型前解除助手的外键引用（schema 的这两个外键没有 ON DELETE 动作）。
func (a *AppAPI) clearAssistantReferences(removedID string, providerScope bool) error {
	assistants, err := a.assistants.List()
	if err != nil {
		return wrapRepoErr("读取助手失败", "", err)
	}
	var providerModels map[string]struct{}
	if providerScope {
		models, err := a.models.List(removedID)
		if err != nil {
			return wrapRepoErr("读取模型失败", "", err)
		}
		providerModels = make(map[string]struct{}, len(models))
		for _, model := range models {
			providerModels[model.ID] = struct{}{}
		}
	}
	now := nowMs()
	for _, assistant := range assistants {
		changed := false
		switch {
		case providerScope && assistant.ProviderID == removedID:
			assistant.ProviderID = ""
			assistant.ModelID = ""
			changed = true
		case assistant.ModelID == removedID:
			assistant.ModelID = ""
			changed = true
		case providerModels != nil && assistant.ModelID != "":
			if _, ok := providerModels[assistant.ModelID]; ok {
				assistant.ModelID = ""
				changed = true
			}
		}
		if !changed {
			continue
		}
		assistant.UpdatedAt = now
		if err := a.assistants.Update(assistant); err != nil {
			return wrapRepoErr("解除助手引用失败", "助手不存在", err)
		}
	}
	return nil
}

// TestProvider 走受限网络桥 GET 模型列表接口探测连通性（不发送任何聊天请求）。
func (a *AppAPI) TestProvider(id string) (ConnectionResultDTO, error) {
	if err := a.ready(); err != nil {
		return ConnectionResultDTO{}, err
	}
	if err := validateUUID("模型服务 ID", id); err != nil {
		return ConnectionResultDTO{}, err
	}
	provider, err := a.providers.Get(strings.TrimSpace(id))
	if err != nil {
		return ConnectionResultDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
	}
	if strings.TrimSpace(provider.BaseURL) == "" {
		return ConnectionResultDTO{Message: "该服务未配置地址"}, nil
	}
	apiKey, err := a.providerKey(provider)
	if err != nil {
		return ConnectionResultDTO{Message: trimErrText(err.Error())}, nil
	}

	start := time.Now()
	resp, err := a.internalGet(provider, modelPathOf(provider), apiKey, testProviderTimeout)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ConnectionResultDTO{LatencyMs: latency, Message: trimErrText(err.Error())}, nil
	}
	if resp.status < 200 || resp.status >= 300 {
		return ConnectionResultDTO{
			LatencyMs: latency,
			Message:   fmt.Sprintf("服务返回 HTTP %d %s", resp.status, strings.TrimSpace(resp.statusText)),
		}, nil
	}
	count := len(parseRemoteModels(resp.body))
	message := "连接成功"
	if count > 0 {
		message = fmt.Sprintf("连接成功，检测到 %d 个模型", count)
	}
	return ConnectionResultDTO{OK: true, LatencyMs: latency, Message: message, ModelCount: count}, nil
}

// SyncProviderModels 拉取远端模型列表并事务性同步；失败只写入 LastSyncError。
func (a *AppAPI) SyncProviderModels(id string) (ModelSyncResultDTO, error) {
	if err := a.ready(); err != nil {
		return ModelSyncResultDTO{}, err
	}
	if err := validateUUID("模型服务 ID", id); err != nil {
		return ModelSyncResultDTO{}, err
	}
	provider, err := a.providers.Get(strings.TrimSpace(id))
	if err != nil {
		return ModelSyncResultDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
	}

	start := time.Now()
	result := ModelSyncResultDTO{}
	fail := func(message string) (ModelSyncResultDTO, error) {
		message = trimErrText(message)
		if err := a.providers.SetSyncResult(provider.ID, nowMs(), message); err != nil {
			logging.Errorf("写入同步结果失败: %v", err)
		}
		result.Error = message
		result.DurationMs = time.Since(start).Milliseconds()
		result.Models = a.syncedModelsOrEmpty(provider.ID)
		result.Total = len(result.Models)
		return result, nil
	}

	if strings.TrimSpace(provider.BaseURL) == "" {
		return fail("该服务未配置地址")
	}
	apiKey, err := a.providerKey(provider)
	if err != nil {
		return fail(err.Error())
	}
	resp, err := a.internalGet(provider, modelPathOf(provider), apiKey, syncModelsTimeout)
	if err != nil {
		return fail(err.Error())
	}
	if resp.status < 200 || resp.status >= 300 {
		return fail(fmt.Sprintf("服务返回 HTTP %d %s", resp.status, strings.TrimSpace(resp.statusText)))
	}
	items := parseRemoteModels(resp.body)
	if len(items) == 0 {
		return fail("服务未返回任何模型")
	}

	seen := make([]string, 0, len(items))
	for _, item := range items {
		seen = append(seen, item.RemoteID)
	}
	now := nowMs()
	added, updated, err := a.models.UpsertSynced(provider.ID, items, now)
	if err != nil {
		return ModelSyncResultDTO{}, wrapRepoErr("写入模型失败", "", err)
	}
	missing, err := a.models.MarkMissing(provider.ID, seen, now)
	if err != nil {
		return ModelSyncResultDTO{}, wrapRepoErr("标记失联模型失败", "", err)
	}
	if err := a.providers.SetSyncResult(provider.ID, now, ""); err != nil {
		logging.Errorf("写入同步结果失败: %v", err)
	}

	result.Added = added
	result.Updated = updated
	result.Missing = missing
	result.Models = a.syncedModelsOrEmpty(provider.ID)
	result.Total = len(result.Models)
	result.DurationMs = time.Since(start).Milliseconds()
	return result, nil
}

func (a *AppAPI) syncedModelsOrEmpty(providerID string) []ModelDTO {
	models, err := a.listModels(providerID)
	if err != nil {
		logging.Errorf("读取模型列表失败: %v", err)
		return []ModelDTO{}
	}
	return models
}

func (a *AppAPI) providerKey(p repository.Provider) (string, error) {
	if len(p.APIKeyCipher) == 0 {
		return "", nil
	}
	plain, err := a.secrets.Decrypt(p.APIKeyCipher)
	if err != nil {
		return "", errors.New("密钥解密失败，请重新填写 API Key")
	}
	return plain, nil
}

func modelPathOf(p repository.Provider) string {
	path := strings.TrimSpace(p.ModelPath)
	if path == "" {
		return defaultModelPath
	}
	return ensureLeadingSlash(path)
}

// ---------------------------------------------------------------- models

func (a *AppAPI) ListModels(providerID string) ([]ModelDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.listModels(providerID)
}

func (a *AppAPI) listModels(providerID string) ([]ModelDTO, error) {
	filter := strings.TrimSpace(providerID)
	if filter != "" {
		if err := validateUUID("模型服务 ID", filter); err != nil {
			return nil, err
		}
	}
	list, err := a.models.List(filter)
	if err != nil {
		return nil, wrapRepoErr("读取模型失败", "", err)
	}
	out := make([]ModelDTO, 0, len(list))
	for _, item := range list {
		out = append(out, toModelDTO(item))
	}
	return out, nil
}

// SaveManualModel 新建或更新手动模型；modality 留空时按模型 ID 启发式判定。
func (a *AppAPI) SaveManualModel(input SaveModelDTO) (ModelDTO, error) {
	if err := a.ready(); err != nil {
		return ModelDTO{}, err
	}
	if err := validateUUID("模型服务 ID", input.ProviderID); err != nil {
		return ModelDTO{}, err
	}
	providerID := strings.TrimSpace(input.ProviderID)
	if _, err := a.providers.Get(providerID); err != nil {
		return ModelDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
	}
	remoteID := strings.TrimSpace(input.RemoteID)
	if remoteID == "" {
		return ModelDTO{}, errors.New("远端模型 ID 不能为空")
	}
	if err := validateTextLen("远端模型 ID", remoteID, maxRemoteIDLen); err != nil {
		return ModelDTO{}, err
	}
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		displayName = remoteID
	}
	if err := validateTextLen("模型名称", displayName, maxTitleLen); err != nil {
		return ModelDTO{}, err
	}
	modality := strings.TrimSpace(input.Modality)
	if modality == "" {
		modality = heuristicModality(remoteID)
	}
	if err := validateEnum("模型类型", modality, modalities); err != nil {
		return ModelDTO{}, err
	}

	now := nowMs()
	var model repository.Model
	creating := strings.TrimSpace(input.ID) == ""
	if creating {
		model = repository.Model{
			ID:               uuid.NewString(),
			ProviderID:       providerID,
			CapabilitiesJSON: "{}",
			Source:           "manual",
			Enabled:          true,
			LastSeenAt:       now,
		}
	} else {
		if err := validateUUID("模型 ID", input.ID); err != nil {
			return ModelDTO{}, err
		}
		existing, err := a.models.Get(strings.TrimSpace(input.ID))
		if err != nil {
			return ModelDTO{}, wrapRepoErr("读取模型失败", "模型不存在", err)
		}
		model = existing
	}
	model.RemoteID = remoteID
	model.DisplayName = displayName
	model.Modality = modality

	if creating {
		if err := a.models.CreateManual(model); err != nil {
			return ModelDTO{}, wrapRepoErr("保存模型失败", "", err)
		}
	} else if err := a.models.Update(model); err != nil {
		return ModelDTO{}, wrapRepoErr("保存模型失败", "模型不存在", err)
	}
	return toModelDTO(model), nil
}

func (a *AppAPI) SetModelEnabled(id string, enabled bool) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("模型 ID", id); err != nil {
		return err
	}
	if err := a.models.SetEnabled(strings.TrimSpace(id), enabled); err != nil {
		return wrapRepoErr("更新模型失败", "模型不存在", err)
	}
	return nil
}

func (a *AppAPI) DeleteModel(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("模型 ID", id); err != nil {
		return err
	}
	modelID := strings.TrimSpace(id)
	if err := a.clearAssistantReferences(modelID, false); err != nil {
		return err
	}
	if err := a.models.Delete(modelID); err != nil {
		return wrapRepoErr("删除模型失败", "模型不存在", err)
	}
	return nil
}

// ---------------------------------------------------------------- assistants

func (a *AppAPI) ListAssistants() ([]AssistantDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	list, err := a.assistants.List()
	if err != nil {
		return nil, wrapRepoErr("读取助手失败", "", err)
	}
	out := make([]AssistantDTO, 0, len(list))
	for _, item := range list {
		out = append(out, toAssistantDTO(item))
	}
	return out, nil
}

// SaveAssistant 新建或更新助手；名称/Emoji 留空时使用默认值。
func (a *AppAPI) SaveAssistant(input SaveAssistantDTO) (AssistantDTO, error) {
	if err := a.ready(); err != nil {
		return AssistantDTO{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "新助手"
	}
	if err := validateTextLen("助手名称", name, maxNameLen); err != nil {
		return AssistantDTO{}, err
	}
	emoji := strings.TrimSpace(input.Emoji)
	if emoji == "" {
		emoji = defaultAssistantEmoji
	}
	if err := validateTextLen("助手 Emoji", emoji, 16); err != nil {
		return AssistantDTO{}, err
	}
	if err := validateTextLen("系统提示词", input.SystemPrompt, maxPromptLen); err != nil {
		return AssistantDTO{}, err
	}
	if input.TemperatureSet && (input.Temperature < 0 || input.Temperature > 2) {
		return AssistantDTO{}, errors.New("温度必须在 0 到 2 之间")
	}
	providerID := strings.TrimSpace(input.ProviderID)
	if providerID != "" {
		if err := validateUUID("模型服务 ID", providerID); err != nil {
			return AssistantDTO{}, err
		}
		if _, err := a.providers.Get(providerID); err != nil {
			return AssistantDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
		}
	}
	modelID := strings.TrimSpace(input.ModelID)
	if modelID != "" {
		if err := validateUUID("模型 ID", modelID); err != nil {
			return AssistantDTO{}, err
		}
		if _, err := a.models.Get(modelID); err != nil {
			return AssistantDTO{}, wrapRepoErr("读取模型失败", "模型不存在", err)
		}
	}

	now := nowMs()
	var assistant repository.Assistant
	creating := strings.TrimSpace(input.ID) == ""
	if creating {
		count, err := a.assistants.Count()
		if err != nil {
			return AssistantDTO{}, wrapRepoErr("读取助手数量失败", "", err)
		}
		assistant = repository.Assistant{ID: uuid.NewString(), SortOrder: count, CreatedAt: now}
	} else {
		if err := validateUUID("助手 ID", input.ID); err != nil {
			return AssistantDTO{}, err
		}
		existing, err := a.assistants.Get(strings.TrimSpace(input.ID))
		if err != nil {
			return AssistantDTO{}, wrapRepoErr("读取助手失败", "助手不存在", err)
		}
		assistant = existing
	}
	assistant.Name = name
	assistant.Emoji = emoji
	assistant.SystemPrompt = input.SystemPrompt
	assistant.ProviderID = providerID
	assistant.ModelID = modelID
	assistant.Temperature = input.Temperature
	assistant.TemperatureSet = input.TemperatureSet
	assistant.WebSearchDefault = input.WebSearchDefault
	assistant.UpdatedAt = now

	if creating {
		if err := a.assistants.Create(assistant); err != nil {
			return AssistantDTO{}, wrapRepoErr("保存助手失败", "", err)
		}
	} else if err := a.assistants.Update(assistant); err != nil {
		return AssistantDTO{}, wrapRepoErr("保存助手失败", "助手不存在", err)
	}
	return toAssistantDTO(assistant), nil
}

// DeleteAssistant 删除助手；删除最后一个助手后重建默认助手与默认话题。
func (a *AppAPI) DeleteAssistant(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("助手 ID", id); err != nil {
		return err
	}
	assistantID := strings.TrimSpace(id)
	if err := a.assistants.Delete(assistantID); err != nil {
		return wrapRepoErr("删除助手失败", "助手不存在", err)
	}
	return a.restoreAssistantInvariant(assistantID)
}

func (a *AppAPI) restoreAssistantInvariant(deletedID string) error {
	list, err := a.assistants.List()
	if err != nil {
		return wrapRepoErr("读取助手失败", "", err)
	}
	settings, err := a.loadAppSettings()
	if err != nil {
		return err
	}
	if len(list) == 0 {
		assistant, err := a.createDefaultAssistant(0)
		if err != nil {
			return err
		}
		topic, err := a.createTopic(assistant.ID, defaultTopicTitle)
		if err != nil {
			return err
		}
		settings.ActiveAssistantID = assistant.ID
		settings.ActiveTopicID = topic.ID
		return a.saveAppSettings(settings)
	}
	if settings.ActiveAssistantID == deletedID || !hasAssistant(list, settings.ActiveAssistantID) {
		settings.ActiveAssistantID = list[0].ID
		settings.ActiveTopicID = ""
		return a.saveAppSettings(settings)
	}
	return nil
}

// ---------------------------------------------------------------- topics

func (a *AppAPI) ListTopics(assistantID string) ([]TopicDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if err := validateUUID("助手 ID", assistantID); err != nil {
		return nil, err
	}
	if _, err := a.assistants.Get(strings.TrimSpace(assistantID)); err != nil {
		return nil, wrapRepoErr("读取助手失败", "助手不存在", err)
	}
	return a.listTopics(strings.TrimSpace(assistantID))
}

func (a *AppAPI) listTopics(assistantID string) ([]TopicDTO, error) {
	list, err := a.topics.ListByAssistant(assistantID)
	if err != nil {
		return nil, wrapRepoErr("读取话题失败", "", err)
	}
	// 分支标记一次批量查出；统计失败只影响展示，按“无分支”降级。
	branched, err := a.topics.HasBranchesByAssistant(assistantID)
	if err != nil {
		logging.Errorf("统计话题分支失败: %v", err)
	}
	out := make([]TopicDTO, 0, len(list))
	for _, item := range list {
		count, err := a.topics.CountMessages(item.ID)
		if err != nil {
			count = 0
		}
		out = append(out, toTopicDTO(item, count, branched[item.ID]))
	}
	return out, nil
}

func (a *AppAPI) CreateTopic(input CreateTopicDTO) (TopicDTO, error) {
	if err := a.ready(); err != nil {
		return TopicDTO{}, err
	}
	if err := validateUUID("助手 ID", input.AssistantID); err != nil {
		return TopicDTO{}, err
	}
	assistantID := strings.TrimSpace(input.AssistantID)
	if _, err := a.assistants.Get(assistantID); err != nil {
		return TopicDTO{}, wrapRepoErr("读取助手失败", "助手不存在", err)
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		title = defaultTopicTitle
	}
	if err := validateTextLen("话题标题", title, maxTitleLen); err != nil {
		return TopicDTO{}, err
	}
	topic, err := a.createTopic(assistantID, title)
	if err != nil {
		return TopicDTO{}, err
	}
	return toTopicDTO(topic, 0, false), nil
}

func (a *AppAPI) RenameTopic(id string, title string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("话题 ID", id); err != nil {
		return err
	}
	value := strings.TrimSpace(title)
	if value == "" {
		return errors.New("话题标题不能为空")
	}
	if err := validateTextLen("话题标题", value, maxTitleLen); err != nil {
		return err
	}
	if err := a.topics.Rename(strings.TrimSpace(id), value, nowMs()); err != nil {
		return wrapRepoErr("重命名话题失败", "话题不存在", err)
	}
	return nil
}

func (a *AppAPI) DeleteTopic(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("话题 ID", id); err != nil {
		return err
	}
	if err := a.topics.Delete(strings.TrimSpace(id)); err != nil {
		return wrapRepoErr("删除话题失败", "话题不存在", err)
	}
	return nil
}

// ---------------------------------------------------------------- messages

// ListMessages 返回话题整条活动分支的 DTO。
// beforeOrder/limit 是契约保留的分页参数：树模型下始终返回完整分支，二者不再生效。
func (a *AppAPI) ListMessages(topicID string, beforeOrder int, limit int) ([]MessageDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if err := validateUUID("话题 ID", topicID); err != nil {
		return nil, err
	}
	_, all, path, err := a.loadTopicPath(strings.TrimSpace(topicID))
	if err != nil {
		return nil, err
	}
	return pathMessageDTOs(path, all), nil
}

// StartTurn 落库用户消息与助手占位消息，并返回本轮上下文快照。
func (a *AppAPI) StartTurn(input StartTurnDTO) (TurnDTO, error) {
	if err := a.ready(); err != nil {
		return TurnDTO{}, err
	}
	if err := validateUUID("话题 ID", input.TopicID); err != nil {
		return TurnDTO{}, err
	}
	topic, all, path, err := a.loadTopicPath(strings.TrimSpace(input.TopicID))
	if err != nil {
		return TurnDTO{}, err
	}

	userText := input.UserText
	if strings.TrimSpace(userText) == "" {
		return TurnDTO{}, errors.New("消息内容不能为空")
	}
	if err := validateTextLen("消息内容", userText, maxMessageLen); err != nil {
		return TurnDTO{}, err
	}
	target, err := a.resolveTurnTarget(input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)
	if err != nil {
		return TurnDTO{}, err
	}

	// 新消息挂在当前活动分支末端：空话题从根开始，否则成为活动节点的子节点（继续追问即新分支）。
	parentID := ""
	if len(path) > 0 {
		parentID = path[len(path)-1].ID
	}
	history := pathMessageDTOs(path, all)

	order, err := a.messages.NextSortOrder(topic.ID)
	if err != nil {
		return TurnDTO{}, wrapRepoErr("读取消息顺序失败", "", err)
	}
	now := nowMs()
	userMessage := repository.Message{
		ID:            uuid.NewString(),
		TopicID:       topic.ID,
		ParentID:      parentID,
		Role:          "user",
		Status:        "done",
		PartsJSON:     textPartsJSON(userText),
		ProviderID:    target.providerID,
		ModelRemoteID: target.remoteID,
		SortOrder:     order,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := a.messages.Create(userMessage); err != nil {
		return TurnDTO{}, wrapRepoErr("保存消息失败", "", err)
	}
	assistantMessage := repository.Message{
		ID:            uuid.NewString(),
		TopicID:       topic.ID,
		ParentID:      userMessage.ID,
		Role:          "assistant",
		Status:        "streaming",
		PartsJSON:     "[]",
		ProviderID:    target.providerID,
		ModelRemoteID: target.remoteID,
		SortOrder:     order + 1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := a.messages.Create(assistantMessage); err != nil {
		// 占位消息失败时回滚刚写入的用户消息，避免留下孤立的半轮对话。
		if delErr := a.messages.Delete(userMessage.ID); delErr != nil {
			logging.Errorf("回滚用户消息失败: %v", delErr)
		}
		return TurnDTO{}, wrapRepoErr("创建助手消息失败", "", err)
	}
	// 活动节点只影响展示与后续上下文，写入失败不阻断本轮对话。
	if err := a.topics.SetActiveNode(topic.ID, assistantMessage.ID, now); err != nil {
		logging.Errorf("切换活动分支失败: %v", err)
	}

	if strings.TrimSpace(topic.Title) == "" || topic.Title == defaultTopicTitle {
		if title := autoTitle(userText); title != "" {
			if err := a.topics.Rename(topic.ID, title, now); err != nil {
				logging.Errorf("自动命名话题失败: %v", err)
			} else {
				topic.Title = title
			}
		}
	}
	if err := a.topics.Touch(topic.ID, now); err != nil {
		logging.Errorf("更新话题时间失败: %v", err)
	}
	topic.UpdatedAt = now
	topic.ActiveNodeID = assistantMessage.ID
	count, err := a.topics.CountMessages(topic.ID)
	if err != nil {
		count = 0
	}
	combined := withMessages(all, userMessage, assistantMessage)

	return TurnDTO{
		Topic:            toTopicDTO(topic, count, branchesIn(combined)),
		UserMessage:      siblingMessageDTO(combined, userMessage),
		AssistantMessage: siblingMessageDTO(combined, assistantMessage),
		Assistant:        toAssistantDTO(a.assistantOf(topic)),
		Model:            toModelDTO(target.model),
		Provider:         a.toProviderDTO(target.provider),
		History:          history,
	}, nil
}

// StartAssistantMessage 为指定用户消息创建新的助手回答（“重新生成”时旧回答保留为兄弟变体）。
func (a *AppAPI) StartAssistantMessage(input StartAssistantMessageDTO) (TurnDTO, error) {
	if err := a.ready(); err != nil {
		return TurnDTO{}, err
	}
	if err := validateUUID("话题 ID", input.TopicID); err != nil {
		return TurnDTO{}, err
	}
	if err := validateUUID("父消息 ID", input.ParentMessageID); err != nil {
		return TurnDTO{}, err
	}
	target, err := a.resolveTurnTarget(input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)
	if err != nil {
		return TurnDTO{}, err
	}
	topic, all, _, err := a.loadTopicPath(strings.TrimSpace(input.TopicID))
	if err != nil {
		return TurnDTO{}, err
	}
	parent := findMessage(all, strings.TrimSpace(input.ParentMessageID))
	if parent.ID == "" || parent.Role != "user" {
		return TurnDTO{}, errors.New("只能对用户消息生成回复")
	}
	// 上下文是该用户消息所在分支，且去掉这条用户消息本身。
	branch := pathTo(all, parent.ID)
	if len(branch) > 0 {
		branch = branch[:len(branch)-1]
	}
	history := pathMessageDTOs(branch, all)

	order, err := a.messages.NextSortOrder(topic.ID)
	if err != nil {
		return TurnDTO{}, wrapRepoErr("读取消息顺序失败", "", err)
	}
	now := nowMs()
	message := repository.Message{
		ID:            uuid.NewString(),
		TopicID:       topic.ID,
		ParentID:      parent.ID,
		Role:          "assistant",
		Status:        "streaming",
		PartsJSON:     "[]",
		ProviderID:    target.providerID,
		ModelRemoteID: target.remoteID,
		SortOrder:     order,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := a.messages.Create(message); err != nil {
		return TurnDTO{}, wrapRepoErr("创建助手消息失败", "", err)
	}
	if err := a.topics.SetActiveNode(topic.ID, message.ID, now); err != nil {
		logging.Errorf("切换活动分支失败: %v", err)
	}
	if err := a.topics.Touch(topic.ID, now); err != nil {
		logging.Errorf("更新话题时间失败: %v", err)
	}
	topic.UpdatedAt = now
	topic.ActiveNodeID = message.ID
	count, err := a.topics.CountMessages(topic.ID)
	if err != nil {
		count = 0
	}
	combined := withMessages(all, message)

	return TurnDTO{
		Topic:            toTopicDTO(topic, count, branchesIn(combined)),
		UserMessage:      siblingMessageDTO(combined, parent),
		AssistantMessage: siblingMessageDTO(combined, message),
		Assistant:        toAssistantDTO(a.assistantOf(topic)),
		Model:            toModelDTO(target.model),
		Provider:         a.toProviderDTO(target.provider),
		History:          history,
	}, nil
}

// SaveTurnSnapshot 只更新流式过程中的 parts_json/status/updated_at。
func (a *AppAPI) SaveTurnSnapshot(input SaveMessageSnapshotDTO) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("消息 ID", input.MessageID); err != nil {
		return err
	}
	if err := validatePartsJSON("消息片段", input.PartsJSON); err != nil {
		return err
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = "streaming"
	}
	if err := validateEnum("消息状态", status, messageStatus); err != nil {
		return err
	}
	if err := ignoreMissing(a.messages.UpdateParts(strings.TrimSpace(input.MessageID), input.PartsJSON, status, nowMs())); err != nil {
		return wrapRepoErr("保存消息快照失败", "", err)
	}
	return nil
}

// FinishTurn 写入最终 parts 与状态（done|cancelled|error）。
func (a *AppAPI) FinishTurn(input FinishTurnDTO) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("消息 ID", input.MessageID); err != nil {
		return err
	}
	status := strings.TrimSpace(input.Status)
	if status == "" {
		status = "done"
	}
	if err := validateEnum("消息状态", status, finalStatus); err != nil {
		return err
	}
	if err := validatePartsJSON("消息片段", input.PartsJSON); err != nil {
		return err
	}
	errorCode := trimOptionalErr(input.ErrorCode)
	errorMessage := trimOptionalErr(input.ErrorMessage)
	if err := ignoreMissing(a.messages.Finish(strings.TrimSpace(input.MessageID), input.PartsJSON, status, errorCode, errorMessage, nowMs())); err != nil {
		return wrapRepoErr("保存消息失败", "", err)
	}
	return nil
}

func (a *AppAPI) DeleteMessage(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("消息 ID", id); err != nil {
		return err
	}
	if err := a.messages.Delete(strings.TrimSpace(id)); err != nil {
		return wrapRepoErr("删除消息失败", "消息不存在", err)
	}
	return nil
}

// EditAndResendUserMessage 编辑当前分支上的用户消息：生成用户兄弟变体 + 助手占位，并切换到新分支。
func (a *AppAPI) EditAndResendUserMessage(input EditMessageDTO) (TurnDTO, error) {
	if err := a.ready(); err != nil {
		return TurnDTO{}, err
	}
	if err := validateUUID("消息 ID", input.MessageID); err != nil {
		return TurnDTO{}, err
	}
	text := input.Text
	if strings.TrimSpace(text) == "" {
		return TurnDTO{}, errors.New("消息内容不能为空")
	}
	if err := validateTextLen("消息内容", text, maxMessageLen); err != nil {
		return TurnDTO{}, err
	}
	target, err := a.resolveTurnTarget(input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)
	if err != nil {
		return TurnDTO{}, err
	}
	original, err := a.messages.Get(strings.TrimSpace(input.MessageID))
	if err != nil {
		return TurnDTO{}, wrapRepoErr("读取消息失败", "消息不存在", err)
	}
	topic, all, path, err := a.loadTopicPath(original.TopicID)
	if err != nil {
		return TurnDTO{}, err
	}
	// 只允许编辑用户消息，且必须落在当前活动分支上。
	if original.Role != "user" || findMessage(path, original.ID).ID == "" {
		return TurnDTO{}, errors.New("只能编辑当前分支上的消息")
	}
	// 新变体的上下文是原消息父节点的分支（不含原消息本身）。
	history := pathMessageDTOs(pathTo(all, original.ParentID), all)

	order, err := a.messages.NextSortOrder(topic.ID)
	if err != nil {
		return TurnDTO{}, wrapRepoErr("读取消息顺序失败", "", err)
	}
	now := nowMs()
	userMessage := repository.Message{
		ID:            uuid.NewString(),
		TopicID:       topic.ID,
		ParentID:      original.ParentID,
		Role:          "user",
		Status:        "done",
		PartsJSON:     textPartsJSON(text),
		ProviderID:    target.providerID,
		ModelRemoteID: target.remoteID,
		SortOrder:     order,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := a.messages.Create(userMessage); err != nil {
		return TurnDTO{}, wrapRepoErr("保存消息失败", "", err)
	}
	assistantMessage := repository.Message{
		ID:            uuid.NewString(),
		TopicID:       topic.ID,
		ParentID:      userMessage.ID,
		Role:          "assistant",
		Status:        "streaming",
		PartsJSON:     "[]",
		ProviderID:    target.providerID,
		ModelRemoteID: target.remoteID,
		SortOrder:     order + 1,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := a.messages.Create(assistantMessage); err != nil {
		// 占位失败时回滚用户变体，避免留下孤立的编辑分支。
		if delErr := a.messages.Delete(userMessage.ID); delErr != nil {
			logging.Errorf("回滚用户消息失败: %v", delErr)
		}
		return TurnDTO{}, wrapRepoErr("创建助手消息失败", "", err)
	}
	if err := a.topics.SetActiveNode(topic.ID, assistantMessage.ID, now); err != nil {
		logging.Errorf("切换活动分支失败: %v", err)
	}
	if err := a.topics.Touch(topic.ID, now); err != nil {
		logging.Errorf("更新话题时间失败: %v", err)
	}
	topic.UpdatedAt = now
	topic.ActiveNodeID = assistantMessage.ID
	count, err := a.topics.CountMessages(topic.ID)
	if err != nil {
		count = 0
	}
	combined := withMessages(all, userMessage, assistantMessage)

	return TurnDTO{
		Topic:            toTopicDTO(topic, count, branchesIn(combined)),
		UserMessage:      siblingMessageDTO(combined, userMessage),
		AssistantMessage: siblingMessageDTO(combined, assistantMessage),
		Assistant:        toAssistantDTO(a.assistantOf(topic)),
		Model:            toModelDTO(target.model),
		Provider:         a.toProviderDTO(target.provider),
		History:          history,
	}, nil
}

// ---------------------------------------------------------------- 分支（消息树）

// topicAndActivePath 返回话题与其活动分支路径（根 → 活动节点，按深度升序）。
func (a *AppAPI) topicAndActivePath(topicID string) (repository.Topic, []repository.Message, error) {
	topic, _, path, err := a.loadTopicPath(strings.TrimSpace(topicID))
	return topic, path, err
}

// loadTopicPath 读取话题、该话题全部消息与活动分支路径；需要兄弟统计的调用方用这个版本。
func (a *AppAPI) loadTopicPath(topicID string) (repository.Topic, []repository.Message, []repository.Message, error) {
	topic, err := a.topics.Get(topicID)
	if err != nil {
		return repository.Topic{}, nil, nil, wrapRepoErr("读取话题失败", "话题不存在", err)
	}
	all, err := a.messages.ListByTopicAll(topic.ID)
	if err != nil {
		return repository.Topic{}, nil, nil, wrapRepoErr("读取消息失败", "", err)
	}
	return topic, all, activePath(topic, all), nil
}

// SetActiveNode 把话题的活动分支末端切到指定消息（消息必须属于该话题）。
func (a *AppAPI) SetActiveNode(topicID string, messageID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("话题 ID", topicID); err != nil {
		return err
	}
	if err := validateUUID("消息 ID", messageID); err != nil {
		return err
	}
	topicID = strings.TrimSpace(topicID)
	message, err := a.messages.Get(strings.TrimSpace(messageID))
	if err != nil {
		return wrapRepoErr("读取消息失败", "消息不存在", err)
	}
	if message.TopicID != topicID {
		return errors.New("消息不属于该话题")
	}
	if err := a.topics.SetActiveNode(topicID, message.ID, nowMs()); err != nil {
		return wrapRepoErr("切换活动分支失败", "话题不存在", err)
	}
	return nil
}

// SwitchToBranch 从指定消息沿「子节点中 sort_order 最大者」一路下探到叶子，
// 使该变体连同它之后的完整延续一起成为活动分支。
func (a *AppAPI) SwitchToBranch(topicID string, messageID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("话题 ID", topicID); err != nil {
		return err
	}
	if err := validateUUID("消息 ID", messageID); err != nil {
		return err
	}
	topicID = strings.TrimSpace(topicID)
	message, err := a.messages.Get(strings.TrimSpace(messageID))
	if err != nil {
		return wrapRepoErr("读取消息失败", "消息不存在", err)
	}
	if message.TopicID != topicID {
		return errors.New("消息不属于该话题")
	}
	all, err := a.messages.ListByTopicAll(topicID)
	if err != nil {
		return wrapRepoErr("读取消息失败", "", err)
	}
	// 每个父节点只保留 sort_order 最大的子节点；循环上限 len(all) 兜底防环。
	next := make(map[string]repository.Message, len(all))
	for _, m := range all {
		if m.ParentID == "" {
			continue
		}
		if current, ok := next[m.ParentID]; !ok || m.SortOrder > current.SortOrder {
			next[m.ParentID] = m
		}
	}
	leaf := message.ID
	for range len(all) {
		child, ok := next[leaf]
		if !ok {
			break
		}
		leaf = child.ID
	}
	if err := a.topics.SetActiveNode(topicID, leaf, nowMs()); err != nil {
		return wrapRepoErr("切换活动分支失败", "话题不存在", err)
	}
	return nil
}

// GetTopicTree 返回话题的完整消息树：先根 DFS，父节点先于子节点，兄弟按 sort_order。
func (a *AppAPI) GetTopicTree(topicID string) (TopicTreeDTO, error) {
	if err := a.ready(); err != nil {
		return TopicTreeDTO{}, err
	}
	if err := validateUUID("话题 ID", topicID); err != nil {
		return TopicTreeDTO{}, err
	}
	topic, all, _, err := a.loadTopicPath(strings.TrimSpace(topicID))
	if err != nil {
		return TopicTreeDTO{}, err
	}

	byID := make(map[string]repository.Message, len(all))
	for _, m := range all {
		byID[m.ID] = m
	}
	children := make(map[string][]repository.Message, len(all))
	roots := make([]repository.Message, 0, 2)
	for _, m := range all {
		// 根节点 = parent_id 为空或父节点不在集合中（异常数据也保证能出现在树里）。
		if _, ok := byID[m.ParentID]; m.ParentID == "" || !ok {
			roots = append(roots, m)
			continue
		}
		children[m.ParentID] = append(children[m.ParentID], m)
	}

	stats := make(map[string]MessageDTO, len(all))
	for _, dto := range pathMessageDTOs(all, all) {
		stats[dto.ID] = dto
	}
	onPath := make(map[string]struct{}, len(all))
	for _, m := range pathTo(all, topic.ActiveNodeID) {
		onPath[m.ID] = struct{}{}
	}

	nodes := make([]TreeNodeDTO, 0, len(all))
	visited := make(map[string]struct{}, len(all))
	var walk func(m repository.Message)
	walk = func(m repository.Message) {
		// 成环节点重复访问时直接跳过，避免无限递归。
		if _, seen := visited[m.ID]; seen {
			return
		}
		visited[m.ID] = struct{}{}
		stat := stats[m.ID]
		_, active := onPath[m.ID]
		kids := children[m.ID]
		nodes = append(nodes, TreeNodeDTO{
			ID:           m.ID,
			ParentID:     m.ParentID,
			Role:         m.Role,
			Status:       m.Status,
			Preview:      previewFromParts(m.PartsJSON),
			SiblingIndex: stat.SiblingIndex,
			SiblingCount: stat.SiblingCount,
			ChildCount:   len(kids),
			OnActivePath: active,
			IsActive:     m.ID == topic.ActiveNodeID,
			CreatedAt:    m.CreatedAt,
		})
		for _, kid := range kids {
			walk(kid)
		}
	}
	for _, root := range roots {
		walk(root)
	}
	return TopicTreeDTO{TopicID: topic.ID, ActiveNodeID: topic.ActiveNodeID, Nodes: nodes}, nil
}

// ---------------------------------------------------------------- settings

// SaveAppSettings 持久化当前助手/话题与主题。
func (a *AppAPI) SaveAppSettings(input SaveAppSettingsDTO) (AppSettingsDTO, error) {
	if err := a.ready(); err != nil {
		return AppSettingsDTO{}, err
	}
	theme := strings.TrimSpace(input.Theme)
	if theme == "" {
		theme = "system"
	}
	if err := validateEnum("主题", theme, themes); err != nil {
		return AppSettingsDTO{}, err
	}
	assistantID := strings.TrimSpace(input.ActiveAssistantID)
	if assistantID != "" {
		if err := validateUUID("助手 ID", assistantID); err != nil {
			return AppSettingsDTO{}, err
		}
		if _, err := a.assistants.Get(assistantID); err != nil {
			return AppSettingsDTO{}, wrapRepoErr("读取助手失败", "助手不存在", err)
		}
	}
	topicID := strings.TrimSpace(input.ActiveTopicID)
	if topicID != "" {
		if err := validateUUID("话题 ID", topicID); err != nil {
			return AppSettingsDTO{}, err
		}
		if _, err := a.topics.Get(topicID); err != nil {
			return AppSettingsDTO{}, wrapRepoErr("读取话题失败", "话题不存在", err)
		}
	}
	settings := AppSettingsDTO{ActiveAssistantID: assistantID, ActiveTopicID: topicID, Theme: theme}
	if err := a.saveAppSettings(settings); err != nil {
		return AppSettingsDTO{}, err
	}
	return settings, nil
}

func (a *AppAPI) GetSearchSettings() (SearchSettingsDTO, error) {
	if err := a.ready(); err != nil {
		return SearchSettingsDTO{}, err
	}
	return a.getSearchSettings()
}

// storedSearchSettings 是写入 settings 表的搜索配置（不含密钥与派生字段）。
type storedSearchSettings struct {
	Enabled    bool
	ServiceID  string
	BaseURL    string
	MaxResults int
}

func (a *AppAPI) getSearchSettings() (SearchSettingsDTO, error) {
	settings := SearchSettingsDTO{ServiceID: defaultSearchService, MaxResults: defaultMaxResults}
	raw, ok, err := a.settings.Get(settingsKeySearch)
	if err != nil {
		return settings, wrapRepoErr("读取搜索设置失败", "", err)
	}
	if ok && strings.TrimSpace(raw) != "" {
		var stored storedSearchSettings
		if err := json.Unmarshal([]byte(raw), &stored); err == nil {
			settings.Enabled = stored.Enabled
			settings.ServiceID = stored.ServiceID
			settings.BaseURL = stored.BaseURL
			settings.MaxResults = stored.MaxResults
		}
	}
	if settings.ServiceID == "" {
		settings.ServiceID = defaultSearchService
	}
	if settings.MaxResults <= 0 {
		settings.MaxResults = defaultMaxResults
	}
	if settings.MaxResults > maxSearchResults {
		settings.MaxResults = maxSearchResults
	}
	_, hasKey, err := a.loadSearchKey()
	if err != nil {
		return settings, err
	}
	settings.HasAPIKey = hasKey
	return settings, nil
}

// SaveSearchSettings 保存搜索配置；密钥与 provider 同规则（留空保留、勾选清除）。
func (a *AppAPI) SaveSearchSettings(input SaveSearchSettingsDTO) (SearchSettingsDTO, error) {
	if err := a.ready(); err != nil {
		return SearchSettingsDTO{}, err
	}
	serviceID := strings.TrimSpace(input.ServiceID)
	if serviceID == "" {
		serviceID = defaultSearchService
	}
	if err := validateEnum("搜索服务类型", serviceID, searchServices); err != nil {
		return SearchSettingsDTO{}, err
	}
	baseURL := strings.TrimSpace(input.BaseURL)
	if baseURL != "" {
		normalized, err := normalizeBaseURL(baseURL)
		if err != nil {
			return SearchSettingsDTO{}, err
		}
		baseURL = normalized
	} else if input.Enabled {
		return SearchSettingsDTO{}, errors.New("启用联网搜索前请填写搜索服务地址")
	}
	maxResults := input.MaxResults
	if maxResults <= 0 {
		maxResults = defaultMaxResults
	}
	if maxResults > maxSearchResults {
		return SearchSettingsDTO{}, fmt.Errorf("最大结果数不能超过 %d", maxSearchResults)
	}

	now := nowMs()
	switch {
	case input.ClearAPIKey:
		if err := a.saveSearchKey(""); err != nil {
			return SearchSettingsDTO{}, err
		}
	case strings.TrimSpace(input.APIKey) != "":
		if err := a.saveSearchKey(input.APIKey); err != nil {
			return SearchSettingsDTO{}, err
		}
	}
	stored := storedSearchSettings{Enabled: input.Enabled, ServiceID: serviceID, BaseURL: baseURL, MaxResults: maxResults}
	raw, err := json.Marshal(stored)
	if err != nil {
		return SearchSettingsDTO{}, errors.New("搜索设置序列化失败")
	}
	if err := a.settings.Set(settingsKeySearch, string(raw), now); err != nil {
		return SearchSettingsDTO{}, wrapRepoErr("保存搜索设置失败", "", err)
	}
	return a.getSearchSettings()
}

func (a *AppAPI) saveSearchKey(plain string) error {
	if plain == "" {
		if err := a.settings.Set(settingsKeySearchKey, `""`, nowMs()); err != nil {
			return wrapRepoErr("清除搜索密钥失败", "", err)
		}
		return nil
	}
	cipher, err := a.secrets.Encrypt(plain)
	if err != nil {
		return errors.New("密钥加密失败")
	}
	raw, err := json.Marshal(base64.StdEncoding.EncodeToString(cipher))
	if err != nil {
		return errors.New("密钥序列化失败")
	}
	if err := a.settings.Set(settingsKeySearchKey, string(raw), nowMs()); err != nil {
		return wrapRepoErr("保存搜索密钥失败", "", err)
	}
	return nil
}

// loadSearchKey 返回解密后的搜索密钥；未配置时返回 ("", false, nil)。
func (a *AppAPI) loadSearchKey() (string, bool, error) {
	raw, ok, err := a.settings.Get(settingsKeySearchKey)
	if err != nil {
		return "", false, wrapRepoErr("读取搜索密钥失败", "", err)
	}
	if !ok || strings.TrimSpace(raw) == "" {
		return "", false, nil
	}
	var encoded string
	if err := json.Unmarshal([]byte(raw), &encoded); err != nil {
		encoded = strings.Trim(strings.TrimSpace(raw), `"`)
	}
	if encoded == "" {
		return "", false, nil
	}
	cipher, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", false, errors.New("搜索密钥格式非法")
	}
	plain, err := a.secrets.Decrypt(cipher)
	if err != nil {
		return "", false, errors.New("搜索密钥解密失败，请重新填写")
	}
	return plain, true, nil
}

// Search 经受限网络桥调用 SearXNG JSON 接口；未启用或未配置地址直接报错。
func (a *AppAPI) Search(input SearchRequestDTO) (SearchResponseDTO, error) {
	if err := a.ready(); err != nil {
		return SearchResponseDTO{}, err
	}
	query := strings.TrimSpace(input.Query)
	if query == "" {
		return SearchResponseDTO{}, errors.New("搜索关键词不能为空")
	}
	if err := validateTextLen("搜索关键词", query, maxQueryLen); err != nil {
		return SearchResponseDTO{}, err
	}
	settings, err := a.getSearchSettings()
	if err != nil {
		return SearchResponseDTO{}, err
	}
	if !settings.Enabled {
		return SearchResponseDTO{}, errors.New("联网搜索未启用")
	}
	if strings.TrimSpace(settings.BaseURL) == "" {
		return SearchResponseDTO{}, errors.New("请先配置搜索服务地址")
	}
	limit := input.Limit
	if limit <= 0 {
		limit = settings.MaxResults
	}
	if limit <= 0 {
		limit = defaultMaxResults
	}
	if limit > maxSearchResults {
		limit = maxSearchResults
	}
	apiKey, _, err := a.loadSearchKey()
	if err != nil {
		return SearchResponseDTO{}, err
	}

	start := time.Now()
	items, err := a.bridge.SearchSearxng(a.baseContext(), transport.Target{
		ID:      settings.ServiceID,
		BaseURL: settings.BaseURL,
		APIKey:  apiKey,
	}, query, limit)
	if err != nil {
		return SearchResponseDTO{}, fmt.Errorf("搜索失败：%s", trimErrText(err.Error()))
	}
	results := make([]SearchResultDTO, 0, len(items))
	for _, item := range items {
		results = append(results, SearchResultDTO{
			Title:   item.Title,
			URL:     item.URL,
			Snippet: item.Snippet,
			Engine:  item.Engine,
		})
	}
	return SearchResponseDTO{Results: results, ElapsedMs: time.Since(start).Milliseconds()}, nil
}

// ---------------------------------------------------------------- transport

// StartProviderRequest 把前端的相对路径请求交给受限网络桥，真实密钥由 Go 注入。
func (a *AppAPI) StartProviderRequest(input ProviderRequestDTO) (RequestHandleDTO, error) {
	if err := a.ready(); err != nil {
		return RequestHandleDTO{}, err
	}
	if err := validateUUID("请求 ID", input.RequestID); err != nil {
		return RequestHandleDTO{}, err
	}
	if err := validateUUID("模型服务 ID", input.ProviderID); err != nil {
		return RequestHandleDTO{}, err
	}
	provider, err := a.providers.Get(strings.TrimSpace(input.ProviderID))
	if err != nil {
		return RequestHandleDTO{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
	}
	if !provider.Enabled {
		return RequestHandleDTO{}, errors.New("该模型服务已停用")
	}
	if strings.TrimSpace(provider.BaseURL) == "" {
		return RequestHandleDTO{}, errors.New("该模型服务未配置地址")
	}
	method := strings.ToUpper(strings.TrimSpace(input.Method))
	if method == "" {
		method = http.MethodPost
	}
	if method != http.MethodGet && method != http.MethodPost {
		return RequestHandleDTO{}, errors.New("只支持 GET/POST 请求")
	}
	if err := validateRelativePath("请求路径", input.Path); err != nil {
		return RequestHandleDTO{}, err
	}
	if _, err := transport.ResolveEndpoint(provider.BaseURL, input.Path); err != nil {
		return RequestHandleDTO{}, errors.New("请求路径非法")
	}

	var body []byte
	if input.Body != "" {
		switch strings.ToLower(strings.TrimSpace(input.BodyEncoding)) {
		case "", "utf8":
			body = []byte(input.Body)
		case "base64":
			decoded, err := base64.StdEncoding.DecodeString(input.Body)
			if err != nil {
				return RequestHandleDTO{}, errors.New("请求体 base64 解码失败")
			}
			body = decoded
		default:
			return RequestHandleDTO{}, errors.New("请求体编码不支持")
		}
	}
	if len(body) > maxRequestBodyBytes {
		return RequestHandleDTO{}, errors.New("请求体过大")
	}
	apiKey, err := a.providerKey(provider)
	if err != nil {
		return RequestHandleDTO{}, err
	}
	timeout := time.Duration(0)
	if input.TimeoutMs > 0 {
		ms := input.TimeoutMs
		if ms > maxRequestTimeoutMs {
			ms = maxRequestTimeoutMs
		}
		timeout = time.Duration(ms) * time.Millisecond
	}

	requestID := strings.TrimSpace(input.RequestID)
	if err := a.bridge.Start(transport.Request{
		ID:      requestID,
		Method:  method,
		Path:    input.Path,
		Headers: input.Headers,
		Body:    body,
		Timeout: timeout,
	}, transport.Target{
		ID:      provider.ID,
		BaseURL: provider.BaseURL,
		APIKey:  apiKey,
	}); err != nil {
		return RequestHandleDTO{}, fmt.Errorf("请求未发出：%s", trimErrText(err.Error()))
	}
	return RequestHandleDTO{RequestID: requestID}, nil
}

func (a *AppAPI) CancelProviderRequest(requestID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("请求 ID", requestID); err != nil {
		return err
	}
	if err := a.bridge.Cancel(strings.TrimSpace(requestID)); err != nil {
		return fmt.Errorf("取消请求失败：%s", trimErrText(err.Error()))
	}
	return nil
}

// OpenExternalURL 只放行 http/https 链接，并交给系统浏览器打开。
func (a *AppAPI) OpenExternalURL(rawURL string) error {
	if err := a.ready(); err != nil {
		return err
	}
	safe, err := platform.ValidateExternalURL(strings.TrimSpace(rawURL))
	if err != nil {
		return errors.New("链接无效或不被允许")
	}
	ctx := a.wailsContext()
	if ctx == nil {
		return errors.New("应用尚未初始化")
	}
	runtime.BrowserOpenURL(ctx, safe)
	return nil
}

// ---------------------------------------------------------------- 内部请求

// internalGet 通过受限网络桥发起同步 GET（模型列表/连通性检测），结果由事件收集得到。
func (a *AppAPI) internalGet(p repository.Provider, path, apiKey string, timeout time.Duration) (internalResponse, error) {
	if err := validateRelativePath("模型列表路径", path); err != nil {
		return internalResponse{}, err
	}
	if _, err := transport.ResolveEndpoint(p.BaseURL, path); err != nil {
		return internalResponse{}, errors.New("模型列表地址非法")
	}
	return a.collect(transport.Request{
		ID:      uuid.NewString(),
		Method:  http.MethodGet,
		Path:    path,
		Headers: map[string]string{"accept": "application/json"},
		Timeout: timeout,
	}, transport.Target{
		ID:      p.ID,
		BaseURL: p.BaseURL,
		APIKey:  apiKey,
	}, timeout)
}

// collect 注册事件收集器后启动请求，等待 end/error 终止信号。
func (a *AppAPI) collect(req transport.Request, target transport.Target, timeout time.Duration) (internalResponse, error) {
	fetch := &syncFetch{done: make(chan struct{})}
	a.mu.Lock()
	a.fetches[req.ID] = fetch
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.fetches, req.ID)
		a.mu.Unlock()
	}()

	if err := a.bridge.Start(req, target); err != nil {
		return internalResponse{}, fmt.Errorf("请求未发出：%s", trimErrText(err.Error()))
	}
	wait := timeout + 15*time.Second
	if timeout <= 0 {
		wait = maxRequestTimeoutMs*time.Millisecond + 15*time.Second
	}
	select {
	case <-fetch.done:
	case <-time.After(wait):
		if err := a.bridge.Cancel(req.ID); err != nil {
			logging.Errorf("取消内部请求失败: %v", err)
		}
		return internalResponse{}, errors.New("请求超时")
	}
	if fetch.errMsg != "" {
		return internalResponse{}, errors.New(fetch.errMsg)
	}
	return internalResponse{status: fetch.status, statusText: fetch.statusText, body: fetch.body}, nil
}

// pendingFetch 返回内部请求的收集器；非内部请求返回 nil。
func (a *AppAPI) pendingFetch(requestID string) *syncFetch {
	if requestID == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.fetches[requestID]
}

// deliverInternal 把内部请求的事件写入收集器；命中时不再转发给前端。
func (a *AppAPI) deliverInternal(payload any) bool {
	switch p := payload.(type) {
	case transport.HeadersPayload:
		return a.collectHeaders(p)
	case *transport.HeadersPayload:
		return p != nil && a.collectHeaders(*p)
	case transport.ChunkPayload:
		return a.collectChunk(p)
	case *transport.ChunkPayload:
		return p != nil && a.collectChunk(*p)
	case transport.EndPayload:
		return a.collectEnd(p.RequestID)
	case *transport.EndPayload:
		return p != nil && a.collectEnd(p.RequestID)
	case transport.ErrorPayload:
		return a.collectError(p)
	case *transport.ErrorPayload:
		return p != nil && a.collectError(*p)
	}
	return false
}

func (a *AppAPI) collectHeaders(p transport.HeadersPayload) bool {
	fetch := a.pendingFetch(p.RequestID)
	if fetch == nil {
		return false
	}
	fetch.status = p.Status
	fetch.statusText = p.StatusText
	return true
}

func (a *AppAPI) collectChunk(p transport.ChunkPayload) bool {
	fetch := a.pendingFetch(p.RequestID)
	if fetch == nil {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(p.DataBase64)
	switch {
	case err != nil:
		fetch.errMsg = "响应内容解码失败"
	case len(fetch.body)+len(raw) > maxInternalBytes:
		fetch.errMsg = "响应内容过大"
	default:
		fetch.body = append(fetch.body, raw...)
	}
	return true
}

func (a *AppAPI) collectEnd(requestID string) bool {
	fetch := a.pendingFetch(requestID)
	if fetch == nil {
		return false
	}
	fetch.finish()
	return true
}

func (a *AppAPI) collectError(p transport.ErrorPayload) bool {
	fetch := a.pendingFetch(p.RequestID)
	if fetch == nil {
		return false
	}
	fetch.errMsg = trimErrText(p.Message)
	fetch.finish()
	return true
}

// ---------------------------------------------------------------- 辅助

// 远端模型条目：兼容 {"data":[{"id":...}]} 与 {"models":[{"name"|"model":...}]}。
type remoteModel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Model       string `json:"model"`
	DisplayName string `json:"display_name"`
	Root        string `json:"root"`
}

func parseRemoteModels(body []byte) []repository.SyncedModel {
	var payload struct {
		Data   []json.RawMessage `json:"data"`
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil
	}
	entries := payload.Data
	if len(entries) == 0 {
		entries = payload.Models
	}
	out := make([]repository.SyncedModel, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		var raw string
		if err := json.Unmarshal(entry, &raw); err == nil {
			raw = strings.TrimSpace(raw)
			if raw == "" {
				continue
			}
			if _, dup := seen[raw]; dup {
				continue
			}
			seen[raw] = struct{}{}
			out = append(out, repository.SyncedModel{
				RemoteID:         raw,
				DisplayName:      raw,
				Modality:         heuristicModality(raw),
				CapabilitiesJSON: "{}",
			})
			continue
		}
		var item remoteModel
		if err := json.Unmarshal(entry, &item); err != nil {
			continue
		}
		remoteID := firstNonEmpty(item.ID, item.Model, item.Name, item.Root)
		if remoteID == "" || utf8.RuneCountInString(remoteID) > maxRemoteIDLen {
			continue
		}
		if _, dup := seen[remoteID]; dup {
			continue
		}
		seen[remoteID] = struct{}{}
		displayName := firstNonEmpty(item.DisplayName, item.Name, item.Model, remoteID)
		if utf8.RuneCountInString(displayName) > maxTitleLen {
			displayName = remoteID
		}
		out = append(out, repository.SyncedModel{
			RemoteID:         remoteID,
			DisplayName:      displayName,
			Modality:         heuristicModality(remoteID),
			CapabilitiesJSON: "{}",
		})
	}
	return out
}

// imageModelHints 是方案 §11.3 的保守启发式：未知一律按文本模型处理。
var imageModelHints = []string{
	"dall-e", "gpt-image", "flux", "stable-diffusion", "sd3", "imagen",
	"kolors", "seedream", "qwen-image", "cogview", "midjourney", "hidream", "janus",
}

func heuristicModality(remoteID string) string {
	lower := strings.ToLower(remoteID)
	for _, hint := range imageModelHints {
		if strings.Contains(lower, hint) {
			return "image"
		}
	}
	return "text"
}

// textPartsJSON 生成用户文本消息的 parts_json。
func textPartsJSON(text string) string {
	part := struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}{Type: "text", Text: text}
	raw, err := json.Marshal([]struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}{part})
	if err != nil {
		return "[]"
	}
	return string(raw)
}

// autoTitle 取用户文本前 30 字作为话题标题，换行折叠为空格。
func autoTitle(text string) string {
	folded := strings.Join(strings.Fields(text), " ")
	runes := []rune(folded)
	if len(runes) > 30 {
		return string(runes[:30])
	}
	return folded
}

func (a *AppAPI) providerByID(id string) (repository.Provider, error) {
	value := strings.TrimSpace(id)
	if value == "" {
		return repository.Provider{}, nil
	}
	if err := validateUUID("模型服务 ID", value); err != nil {
		return repository.Provider{}, err
	}
	provider, err := a.providers.Get(value)
	if err != nil {
		return repository.Provider{}, wrapRepoErr("读取模型服务失败", "模型服务不存在", err)
	}
	return provider, nil
}

func (a *AppAPI) modelByID(id string) (repository.Model, error) {
	value := strings.TrimSpace(id)
	if value == "" {
		return repository.Model{}, nil
	}
	if err := validateUUID("模型 ID", value); err != nil {
		return repository.Model{}, err
	}
	model, err := a.models.Get(value)
	if err != nil {
		return repository.Model{}, wrapRepoErr("读取模型失败", "模型不存在", err)
	}
	return model, nil
}

func toProviderDTO(p repository.Provider, modelCount int) ProviderDTO {
	return ProviderDTO{
		ID:            p.ID,
		Name:          p.Name,
		Kind:          p.Kind,
		BaseURL:       p.BaseURL,
		Enabled:       p.Enabled,
		ModelPath:     p.ModelPath,
		HasAPIKey:     len(p.APIKeyCipher) > 0,
		CreatedAt:     p.CreatedAt,
		UpdatedAt:     p.UpdatedAt,
		LastSyncAt:    p.LastSyncAt,
		LastSyncError: p.LastSyncError,
		ModelCount:    modelCount,
	}
}

func toModelDTO(m repository.Model) ModelDTO {
	return ModelDTO{
		ID:               m.ID,
		ProviderID:       m.ProviderID,
		RemoteID:         m.RemoteID,
		DisplayName:      m.DisplayName,
		Modality:         m.Modality,
		CapabilitiesJSON: m.CapabilitiesJSON,
		Source:           m.Source,
		Enabled:          m.Enabled,
		MissingRemote:    m.MissingRemote,
		LastSeenAt:       m.LastSeenAt,
	}
}

func toAssistantDTO(as repository.Assistant) AssistantDTO {
	return AssistantDTO{
		ID:               as.ID,
		Name:             as.Name,
		Emoji:            as.Emoji,
		SystemPrompt:     as.SystemPrompt,
		ProviderID:       as.ProviderID,
		ModelID:          as.ModelID,
		Temperature:      as.Temperature,
		TemperatureSet:   as.TemperatureSet,
		WebSearchDefault: as.WebSearchDefault,
		SortOrder:        as.SortOrder,
		CreatedAt:        as.CreatedAt,
		UpdatedAt:        as.UpdatedAt,
	}
}

// turnTarget 一轮对话解析后的服务与模型信息（ID 已按“留空回退模型自身归属”规范化）。
type turnTarget struct {
	provider   repository.Provider
	model      repository.Model
	providerID string
	remoteID   string
}

// resolveTurnTarget 校验并解析对话使用的服务与模型：ID 留空时回退到模型自身的归属。
func (a *AppAPI) resolveTurnTarget(providerID, modelID, remoteID, modality string) (turnTarget, error) {
	provider, err := a.providerByID(providerID)
	if err != nil {
		return turnTarget{}, err
	}
	model, err := a.modelByID(modelID)
	if err != nil {
		return turnTarget{}, err
	}
	resolvedProviderID := strings.TrimSpace(providerID)
	if resolvedProviderID == "" {
		resolvedProviderID = model.ProviderID
	}
	resolvedRemoteID := strings.TrimSpace(remoteID)
	if resolvedRemoteID == "" {
		resolvedRemoteID = model.RemoteID
	}
	if err := validateTextLen("远端模型 ID", resolvedRemoteID, maxRemoteIDLen); err != nil {
		return turnTarget{}, err
	}
	value := strings.TrimSpace(modality)
	if value == "" {
		value = model.Modality
	}
	if value != "" {
		if err := validateEnum("模型类型", value, modalities); err != nil {
			return turnTarget{}, err
		}
	}
	return turnTarget{provider: provider, model: model, providerID: resolvedProviderID, remoteID: resolvedRemoteID}, nil
}

// assistantOf 读取话题所属助手；助手已删除或读取失败时返回零值（只影响展示信息）。
func (a *AppAPI) assistantOf(topic repository.Topic) repository.Assistant {
	if topic.AssistantID == "" {
		return repository.Assistant{}
	}
	found, err := a.assistants.Get(topic.AssistantID)
	if err != nil {
		return repository.Assistant{}
	}
	return found
}

func toTopicDTO(t repository.Topic, messageCount int, hasBranches bool) TopicDTO {
	return TopicDTO{
		ID:           t.ID,
		AssistantID:  t.AssistantID,
		Title:        t.Title,
		MessageCount: messageCount,
		ActiveNodeID: t.ActiveNodeID,
		HasBranches:  hasBranches,
		CreatedAt:    t.CreatedAt,
		UpdatedAt:    t.UpdatedAt,
	}
}

// toMessageDTO 转换单条消息；变体序号由 pathMessageDTOs 按父节点补齐，单独转换时为 1/1。
func toMessageDTO(m repository.Message) MessageDTO {
	return MessageDTO{
		ID:            m.ID,
		TopicID:       m.TopicID,
		Role:          m.Role,
		Status:        m.Status,
		PartsJSON:     m.PartsJSON,
		ProviderID:    m.ProviderID,
		ModelRemoteID: m.ModelRemoteID,
		ParentID:      m.ParentID,
		SortOrder:     m.SortOrder,
		SiblingCount:  1,
		SiblingIndex:  1,
		CreatedAt:     m.CreatedAt,
		UpdatedAt:     m.UpdatedAt,
	}
}

// findMessage 在消息集合中按 id 查找；找不到返回零值。
func findMessage(all []repository.Message, id string) repository.Message {
	for _, m := range all {
		if m.ID == id {
			return m
		}
	}
	return repository.Message{}
}

// pathTo 沿 parent_id 从 nodeID 上溯到根并反转，返回根 → 节点的路径；
// nodeID 为空、找不到或链路断裂时返回 nil；visited 防环。
func pathTo(all []repository.Message, nodeID string) []repository.Message {
	if nodeID == "" {
		return nil
	}
	byID := make(map[string]repository.Message, len(all))
	for _, m := range all {
		byID[m.ID] = m
	}
	path := make([]repository.Message, 0, 8)
	visited := make(map[string]struct{}, len(all))
	for current := nodeID; current != ""; {
		if _, seen := visited[current]; seen {
			break
		}
		m, ok := byID[current]
		if !ok {
			return nil
		}
		visited[current] = struct{}{}
		path = append(path, m)
		current = m.ParentID
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

// activePath 返回话题当前活动分支（根 → 活动节点）。
func activePath(topic repository.Topic, all []repository.Message) []repository.Message {
	return pathTo(all, topic.ActiveNodeID)
}

// pathMessageDTOs 把 path 中的消息转成 DTO，并按 all（须为同一话题的全量消息）补齐兄弟序号：
// 同一 parent_id 下的消息互为变体，序号按 sort_order 升序、从 1 起。
func pathMessageDTOs(path, all []repository.Message) []MessageDTO {
	groups := make(map[string][]repository.Message, len(all))
	for _, m := range all {
		groups[m.ParentID] = append(groups[m.ParentID], m)
	}
	out := make([]MessageDTO, 0, len(path))
	for _, m := range path {
		dto := toMessageDTO(m)
		group := groups[m.ParentID]
		if len(group) == 0 {
			out = append(out, dto)
			continue
		}
		dto.SiblingCount = len(group)
		for i, sibling := range group {
			if sibling.ID == m.ID {
				dto.SiblingIndex = i + 1
				break
			}
		}
		out = append(out, dto)
	}
	return out
}

// siblingMessageDTO 依据全量消息为单条消息补齐兄弟序号后转 DTO。
func siblingMessageDTO(all []repository.Message, m repository.Message) MessageDTO {
	dtos := pathMessageDTOs([]repository.Message{m}, all)
	if len(dtos) == 0 {
		return toMessageDTO(m)
	}
	return dtos[0]
}

// branchesIn 判断消息集合中是否存在分支（同一父节点下有多条消息）。
func branchesIn(all []repository.Message) bool {
	seen := make(map[string]int, len(all))
	for _, m := range all {
		seen[m.ParentID]++
		if seen[m.ParentID] > 1 {
			return true
		}
	}
	return false
}

// withMessages 返回 all 与 extra 拼接后的新切片（复制底层数组，避免与调用方共享写入）。
func withMessages(all []repository.Message, extra ...repository.Message) []repository.Message {
	merged := make([]repository.Message, 0, len(all)+len(extra))
	merged = append(merged, all...)
	merged = append(merged, extra...)
	return merged
}

// previewFromParts 提取分支面板用的消息文本摘要；
// 超大 parts_json（可能内嵌 base64 图片）直接放弃解析，取不到文本时返回空。
func previewFromParts(partsJSON string) string {
	if len(partsJSON) > previewPartsBytes {
		return ""
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(partsJSON), &parts); err != nil {
		return ""
	}
	for _, part := range parts {
		if part.Type != "text" {
			continue
		}
		folded := strings.Join(strings.Fields(part.Text), " ")
		if folded == "" {
			continue
		}
		runes := []rune(folded)
		if len(runes) > previewRuneLimit {
			return string(runes[:previewRuneLimit]) + "…"
		}
		return folded
	}
	return ""
}

func pickAssistantID(assistants []AssistantDTO, want string) string {
	for _, item := range assistants {
		if item.ID == want {
			return want
		}
	}
	if len(assistants) == 0 {
		return ""
	}
	return assistants[0].ID
}

func pickTopicID(topics []TopicDTO, want string) string {
	for _, item := range topics {
		if item.ID == want {
			return want
		}
	}
	if len(topics) == 0 {
		return ""
	}
	return topics[0].ID
}

func hasAssistant(list []repository.Assistant, id string) bool {
	if id == "" {
		return false
	}
	for _, item := range list {
		if item.ID == id {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// ignoreMissing 把“目标记录已不存在”视为幂等成功：流式过程中消息可能已被删除或重新生成。
func ignoreMissing(err error) error {
	if err != nil && errors.Is(err, repository.ErrNotFound) {
		return nil
	}
	return err
}

// wrapRepoErr 把仓库错误转成中文提示；ErrNotFound 用专门的提示语。
func wrapRepoErr(prefix, missing string, err error) error {
	if err == nil {
		return nil
	}
	if missing != "" && errors.Is(err, repository.ErrNotFound) {
		return errors.New(missing)
	}
	return fmt.Errorf("%s：%s", prefix, trimErrText(err.Error()))
}

// trimOptionalErr 对可选错误字段做脱敏与截断；空值保持空。
func trimOptionalErr(value string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	return trimErrText(value)
}

// trimErrText 脱敏并截断错误文本，避免密钥或超长堆栈进入 UI。
func trimErrText(message string) string {
	clean := strings.TrimSpace(logging.Redact(message))
	if clean == "" {
		return "未知错误"
	}
	runes := []rune(clean)
	if len(runes) > errorTextLimit {
		return string(runes[:errorTextLimit]) + "…"
	}
	return clean
}

func nowMs() int64 {
	return time.Now().UnixMilli()
}
