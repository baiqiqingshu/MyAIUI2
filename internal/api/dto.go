// Package api 暴露给前端的唯一门面（Wails bindings）。
//
// 契约规则（冻结，改动需重新生成绑定并同步 frontend/src/domain/dto.ts）：
//   - 字段一律 PascalCase，且不写 json tag：Wails 绑定生成与 Go 的 encoding/json
//     都直接使用字段名，两端因此天然一致。
//   - 不使用指针字段、不使用 interface{}、不使用嵌套 map 之外的复杂类型。
//   - 所有 DTO 只描述业务数据，任何 DTO 都不得携带本机文件路径。
package api

// ---------------------------------------------------------------- bootstrap

// AppSettingsDTO 全局设置（settings 表中的白名单字段）。
type AppSettingsDTO struct {
	ActiveAssistantID string
	ActiveTopicID     string
	Theme             string // system | light | dark
}

type SaveAppSettingsDTO struct {
	ActiveAssistantID string
	ActiveTopicID     string
	Theme             string
}

// BootstrapDTO 首屏一次性数据。
type BootstrapDTO struct {
	AppName    string
	Version    string
	Settings   AppSettingsDTO
	Assistants []AssistantDTO
	Providers  []ProviderDTO
	Models     []ModelDTO
	Topics     []TopicDTO
	Search     SearchSettingsDTO
}

// ---------------------------------------------------------------- providers

type ProviderDTO struct {
	ID            string
	Name          string
	Kind          string // openai-compatible | openai | openai-responses
	BaseURL       string
	Enabled       bool
	ModelPath     string
	HasAPIKey     bool
	CreatedAt     int64
	UpdatedAt     int64
	LastSyncAt    int64 // 0 表示从未同步
	LastSyncError string
	ModelCount    int
}

type SaveProviderDTO struct {
	ID          string // 空字符串表示新建
	Name        string
	Kind        string
	BaseURL     string
	APIKey      string // 空字符串表示保留原密钥
	ClearAPIKey bool
	Enabled     bool
	ModelPath   string
}

type ConnectionResultDTO struct {
	OK         bool
	LatencyMs  int64
	Message    string
	ModelCount int
}

// ---------------------------------------------------------------- models

type ModelDTO struct {
	ID               string
	ProviderID       string
	RemoteID         string
	DisplayName      string
	Modality         string // text | image
	CapabilitiesJSON string
	Source           string // synced | manual
	Enabled          bool
	MissingRemote    bool
	LastSeenAt       int64
}

type SaveModelDTO struct {
	ID          string // 空字符串表示新建
	ProviderID  string
	RemoteID    string
	DisplayName string
	Modality    string
}

type ModelSyncResultDTO struct {
	Added      int
	Updated    int
	Missing    int
	Total      int
	DurationMs int64
	Error      string
	Models     []ModelDTO
	// AddedIDs 是本次新插入的 synced 模型 ID（默认未启用），供前端呈现勾选。
	AddedIDs []string
}

// ---------------------------------------------------------------- assistants

type AssistantDTO struct {
	ID               string
	Name             string
	Emoji            string
	SystemPrompt     string
	ProviderID       string
	ModelID          string
	Temperature      float64
	TemperatureSet   bool
	WebSearchDefault bool
	SortOrder        int
	CreatedAt        int64
	UpdatedAt        int64
}

type SaveAssistantDTO struct {
	ID               string // 空字符串表示新建
	Name             string
	Emoji            string
	SystemPrompt     string
	ProviderID       string
	ModelID          string
	Temperature      float64
	TemperatureSet   bool
	WebSearchDefault bool
}

// ---------------------------------------------------------------- topics

type TopicDTO struct {
	ID          string
	AssistantID string
	Title       string
	MessageCount int
	// ActiveNodeID 是当前活动分支的末端消息 ID；空字符串表示该话题还没有消息。
	ActiveNodeID string
	// HasBranches 表示话题内存在分支（某个消息节点有多个子节点）。
	HasBranches bool
	CreatedAt   int64
	UpdatedAt   int64
}

type CreateTopicDTO struct {
	AssistantID string
	Title       string
}

// ---------------------------------------------------------------- messages

type MessageDTO struct {
	ID            string
	TopicID       string
	Role          string // user | assistant
	Status        string // pending | streaming | done | cancelled | error | interrupted
	PartsJSON     string
	ProviderID    string
	ModelRemoteID string
	// ParentID 指向同一话题中的父消息；空字符串表示该话题的根节点。
	ParentID string
	SortOrder int
	// SiblingCount/SiblingIndex 描述同一父节点下的变体关系：无变体时为 1/1。
	SiblingCount int
	SiblingIndex int
	CreatedAt    int64
	UpdatedAt    int64
}

// StartTurnDTO 开始一轮对话：先落库用户消息与助手占位消息。
type StartTurnDTO struct {
	TopicID       string
	Title         string // 话题当前为空标题时，用于自动命名（取前 30 字）
	UserText      string
	ProviderID    string
	ModelID       string
	ModelRemoteID string
	ModelModality string
}

// TurnDTO 一轮对话落库后的返回值。
type TurnDTO struct {
	Topic            TopicDTO
	UserMessage      MessageDTO
	AssistantMessage MessageDTO
	Assistant        AssistantDTO
	Model            ModelDTO
	Provider         ProviderDTO
	History          []MessageDTO // 本话题历史消息（不含本轮两条），按 sort_order 升序
}

// StartAssistantMessageDTO 为指定用户消息创建新的助手回答（重新生成时旧回答保留为兄弟变体）。
type StartAssistantMessageDTO struct {
	TopicID string
	// ParentMessageID 是要回答的用户消息 ID（重新生成时传旧回答的父消息 ID）。
	ParentMessageID string
	ProviderID      string
	ModelID         string
	ModelRemoteID   string
	ModelModality   string
}

// EditMessageDTO 编辑一条用户消息并重新发送：生成兄弟变体、切换活动分支，并创建助手占位消息。
type EditMessageDTO struct {
	MessageID     string
	Text          string
	ProviderID    string
	ModelID       string
	ModelRemoteID string
	ModelModality string
}

type SaveMessageSnapshotDTO struct {
	MessageID string
	PartsJSON string
	Status    string
}

type FinishTurnDTO struct {
	MessageID    string
	PartsJSON    string
	Status       string // done | cancelled | error
	ErrorCode    string
	ErrorMessage string
}

// ---------------------------------------------------------------- search

type SearchSettingsDTO struct {
	Enabled    bool
	ServiceID  string // searxng
	BaseURL    string
	HasAPIKey  bool
	MaxResults int
}

type SaveSearchSettingsDTO struct {
	Enabled     bool
	ServiceID   string
	BaseURL     string
	APIKey      string
	ClearAPIKey bool
	MaxResults  int
}

type SearchRequestDTO struct {
	Query string
	Limit int
}

type SearchResultDTO struct {
	Title   string
	URL     string
	Snippet string
	Engine  string
}

type SearchResponseDTO struct {
	Results   []SearchResultDTO
	ElapsedMs int64
}

// ---------------------------------------------------------------- transport

// ProviderRequestDTO 受限网络桥请求。RequestID 由前端生成（UUID v4）。
type ProviderRequestDTO struct {
	RequestID    string
	ProviderID   string
	Method       string // GET | POST
	Path         string // 只允许相对路径，例如 /v1/chat/completions
	Headers      map[string]string
	Body         string
	BodyEncoding string // utf8 | base64
	TimeoutMs    int64  // 0 表示默认
}

type RequestHandleDTO struct {
	RequestID string
}

// TransportHeadersDTO 事件 transport:headers，前端据此构造 Response。
type TransportHeadersDTO struct {
	RequestID  string
	Status     int
	StatusText string
	Headers    map[string]string
}

// TransportChunkDTO 事件 transport:chunk，DataBase64 为原始响应体分片。
type TransportChunkDTO struct {
	RequestID  string
	DataBase64 string
}

// TransportEndDTO 事件 transport:end。
type TransportEndDTO struct {
	RequestID string
}

// TransportErrorDTO 事件 transport:error，Message 已脱敏。
type TransportErrorDTO struct {
	RequestID string
	Status    int
	Message   string
}

// ---------------------------------------------------------------- 分支与导出

// TreeNodeDTO 会话内分支树的一个节点（只读快照）。
type TreeNodeDTO struct {
	ID           string
	ParentID     string // 空字符串表示根节点
	Role         string
	Status       string
	Preview      string // 消息文本前若干字符，用于分支面板展示
	SiblingIndex int    // 同一父节点下的 1 起序号
	SiblingCount int    // 同一父节点下的变体总数
	ChildCount   int    // 直接子节点数量
	OnActivePath bool   // 是否位于当前活动分支上
	IsActive     bool   // 是否为当前活动节点
	CreatedAt    int64
}

// TopicTreeDTO 话题的完整消息树（先根深度优先，父节点先于子节点）。
type TopicTreeDTO struct {
	TopicID      string
	ActiveNodeID string
	Nodes        []TreeNodeDTO
}

// MarkdownExportDTO 导出的 Markdown 文本；前端负责复制到剪贴板或请求另存为文件。
type MarkdownExportDTO struct {
	TopicID      string
	FileName     string // 建议文件名（不含路径）
	Markdown     string
	MessageCount int // 导出的当前分支消息数
}

// SaveMarkdownResultDTO 另存为结果；Saved=false 表示用户取消了保存对话框。
type SaveMarkdownResultDTO struct {
	Saved    bool
	FileName string // 实际写入的文件名（不含路径）
}
