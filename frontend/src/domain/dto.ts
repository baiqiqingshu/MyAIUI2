// 与 internal/api/dto.go 一一对应的镜像类型。字段名保持 PascalCase，与 Wails
// 绑定生成规则（Go 字段名即 JSON 字段名）一致；两侧改动必须同步。

export interface AppSettingsDTO {
  ActiveAssistantID: string
  ActiveTopicID: string
  Theme: string
}

export interface SaveAppSettingsDTO {
  ActiveAssistantID: string
  ActiveTopicID: string
  Theme: string
}

export interface BootstrapDTO {
  AppName: string
  Version: string
  Settings: AppSettingsDTO
  Assistants: AssistantDTO[]
  Providers: ProviderDTO[]
  Models: ModelDTO[]
  Topics: TopicDTO[]
  Search: SearchSettingsDTO
}

export interface ProviderDTO {
  ID: string
  Name: string
  Kind: string
  BaseURL: string
  Enabled: boolean
  ModelPath: string
  HasAPIKey: boolean
  CreatedAt: number
  UpdatedAt: number
  LastSyncAt: number
  LastSyncError: string
  ModelCount: number
}

export interface SaveProviderDTO {
  ID: string
  Name: string
  Kind: string
  BaseURL: string
  APIKey: string
  ClearAPIKey: boolean
  Enabled: boolean
  ModelPath: string
}

export interface ConnectionResultDTO {
  OK: boolean
  LatencyMs: number
  Message: string
  ModelCount: number
}

export interface ModelDTO {
  ID: string
  ProviderID: string
  RemoteID: string
  DisplayName: string
  Modality: string
  CapabilitiesJSON: string
  Source: string
  Enabled: boolean
  MissingRemote: boolean
  LastSeenAt: number
}

export interface SaveModelDTO {
  ID: string
  ProviderID: string
  RemoteID: string
  DisplayName: string
  Modality: string
}

export interface ModelSyncResultDTO {
  Added: number
  Updated: number
  Missing: number
  Total: number
  DurationMs: number
  Error: string
  Models: ModelDTO[]
  /** 本次新插入的模型 ID（默认未启用），供前端勾选启用。 */
  AddedIDs: string[]
}

export interface AssistantDTO {
  ID: string
  Name: string
  Emoji: string
  SystemPrompt: string
  ProviderID: string
  ModelID: string
  Temperature: number
  TemperatureSet: boolean
  WebSearchDefault: boolean
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

export interface SaveAssistantDTO {
  ID: string
  Name: string
  Emoji: string
  SystemPrompt: string
  ProviderID: string
  ModelID: string
  Temperature: number
  TemperatureSet: boolean
  WebSearchDefault: boolean
}

export interface TopicDTO {
  ID: string
  AssistantID: string
  Title: string
  MessageCount: number
  /** 当前活动分支的末端消息 ID；空字符串表示话题还没有消息 */
  ActiveNodeID: string
  /** 话题内是否存在分支（某个消息节点有多个子节点） */
  HasBranches: boolean
  /** 所在目录 ID；'' = 所属分区（收藏区或普通区）的根级 */
  FolderID: string
  /** 收藏话题；收藏话题在话题栏收藏区展示，目录归属按 Zone='fav' 的目录 */
  Favorite: boolean
  /** 所在容器（目录或分区根）内的排序下标 */
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

export interface CreateTopicDTO {
  AssistantID: string
  Title: string
}

/** 话题目录：Zone '' = 普通区目录，'fav' = 收藏区目录；ParentID 链支持嵌套。 */
export interface TopicFolderDTO {
  ID: string
  AssistantID: string
  ParentID: string
  Name: string
  Zone: string
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

export interface SaveTopicFolderDTO {
  ID: string
  AssistantID: string
  ParentID: string
  Name: string
  Zone: string
  SortOrder: number
}

/** 话题移动/排序：FolderID 为目标目录（'' = 分区根），SortOrder 为目标容器内的插入下标。 */
export interface MoveTopicDTO {
  TopicID: string
  FolderID: string
  Favorite: boolean
  SortOrder: number
}

export interface MoveTopicFolderDTO {
  FolderID: string
  ParentID: string
  Zone: string
  SortOrder: number
}

/** 内置中转（本机 Python 进程）的运行状态。 */
export interface RelayStatusDTO {
  Enabled: boolean
  Running: boolean
  Addr: string
  PythonPath: string
  Error: string
}

export interface MessageDTO {
  ID: string
  TopicID: string
  Role: string
  Status: string
  PartsJSON: string
  ProviderID: string
  ModelRemoteID: string
  /** 同一话题中的父消息 ID；空字符串表示根节点 */
  ParentID: string
  SortOrder: number
  /** 同一父节点下的变体总数（无变体为 1） */
  SiblingCount: number
  /** 当前消息在变体中的 1 起序号 */
  SiblingIndex: number
  CreatedAt: number
  UpdatedAt: number
}

export interface StartTurnDTO {
  TopicID: string
  Title: string
  UserText: string
  ProviderID: string
  ModelID: string
  ModelRemoteID: string
  ModelModality: string
}

export interface TurnDTO {
  Topic: TopicDTO
  UserMessage: MessageDTO
  AssistantMessage: MessageDTO
  Assistant: AssistantDTO
  Model: ModelDTO
  Provider: ProviderDTO
  History: MessageDTO[]
}

export interface StartAssistantMessageDTO {
  TopicID: string
  /** 要回答的用户消息 ID（重新生成时传旧回答的父消息） */
  ParentMessageID: string
  ProviderID: string
  ModelID: string
  ModelRemoteID: string
  ModelModality: string
}

export interface EditMessageDTO {
  MessageID: string
  Text: string
  ProviderID: string
  ModelID: string
  ModelRemoteID: string
  ModelModality: string
}

export interface SaveMessageSnapshotDTO {
  MessageID: string
  PartsJSON: string
  Status: string
}

export interface FinishTurnDTO {
  MessageID: string
  PartsJSON: string
  Status: string
  ErrorCode: string
  ErrorMessage: string
}

export interface SearchSettingsDTO {
  Enabled: boolean
  ServiceID: string
  BaseURL: string
  HasAPIKey: boolean
  MaxResults: number
}

export interface SaveSearchSettingsDTO {
  Enabled: boolean
  ServiceID: string
  BaseURL: string
  APIKey: string
  ClearAPIKey: boolean
  MaxResults: number
}

export interface SearchRequestDTO {
  Query: string
  Limit: number
}

export interface SearchResultDTO {
  Title: string
  URL: string
  Snippet: string
  Engine: string
}

export interface SearchResponseDTO {
  Results: SearchResultDTO[]
  ElapsedMs: number
}

export interface ProviderRequestDTO {
  RequestID: string
  ProviderID: string
  Method: string
  Path: string
  Headers: Record<string, string>
  Body: string
  BodyEncoding: string
  TimeoutMs: number
}

export interface RequestHandleDTO {
  RequestID: string
}

export interface TransportHeadersDTO {
  RequestID: string
  Status: number
  StatusText: string
  Headers: Record<string, string>
}

export interface TransportChunkDTO {
  RequestID: string
  DataBase64: string
}

export interface TransportEndDTO {
  RequestID: string
}

export interface TransportErrorDTO {
  RequestID: string
  Status: number
  Message: string
}

// ---------------------------------------------------------------- 分支与导出

export interface TreeNodeDTO {
  ID: string
  ParentID: string
  Role: string
  Status: string
  Preview: string
  SiblingIndex: number
  SiblingCount: number
  ChildCount: number
  OnActivePath: boolean
  IsActive: boolean
  CreatedAt: number
}

export interface TopicTreeDTO {
  TopicID: string
  ActiveNodeID: string
  Nodes: TreeNodeDTO[]
}

export interface MarkdownExportDTO {
  TopicID: string
  FileName: string
  Markdown: string
  MessageCount: number
}

export interface SaveMarkdownResultDTO {
  Saved: boolean
  FileName: string
}
