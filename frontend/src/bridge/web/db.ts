// 浏览器后端的 localStorage 持久层：业务数据打包成一个 JSON blob 放在 myaiui2.web.v1.db，
// 密钥（provider/search 明文）单独放在 myaiui2.web.v1.secrets——对应桌面端 api_key_cipher
// 与业务表分列的做法。每次 mutate 成功后同步 setItem（写穿透）。

export interface StoredProvider {
  ID: string
  Name: string
  Kind: string
  BaseURL: string
  Enabled: boolean
  ModelPath: string
  CreatedAt: number
  UpdatedAt: number
  LastSyncAt: number
  LastSyncError: string
}

export interface StoredModel {
  ID: string
  ProviderID: string
  RemoteID: string
  DisplayName: string
  Modality: string
  CapabilitiesJSON: string
  /** 'synced' 远端同步 | 'manual' 手动添加 */
  Source: string
  Enabled: boolean
  MissingRemote: boolean
  LastSeenAt: number
}

export interface StoredAssistant {
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

export interface StoredTopic {
  ID: string
  AssistantID: string
  Title: string
  ActiveNodeID: string
  FolderID: string
  Favorite: boolean
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

export interface StoredTopicFolder {
  ID: string
  AssistantID: string
  ParentID: string
  Name: string
  /** '' 普通区目录 | 'fav' 收藏区目录 */
  Zone: string
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

export interface StoredMessage {
  ID: string
  TopicID: string
  ParentID: string
  Role: string
  Status: string
  PartsJSON: string
  ProviderID: string
  ModelRemoteID: string
  SortOrder: number
  CreatedAt: number
  UpdatedAt: number
}

/** 单 blob 形状；settings 是 key -> JSON 文本，对应桌面端 settings 表的 value_json。 */
export interface WebDb {
  settings: Record<string, string>
  assistants: StoredAssistant[]
  providers: StoredProvider[]
  models: StoredModel[]
  topics: StoredTopic[]
  folders: StoredTopicFolder[]
  messages: StoredMessage[]
}

interface WebSecrets {
  providers: Record<string, string>
  search: string
}

const DB_KEY = 'myaiui2.web.v1.db'
const SECRETS_KEY = 'myaiui2.web.v1.secrets'

let dbCache: WebDb | null = null
let secretsCache: WebSecrets | null = null

function emptyDb(): WebDb {
  return { settings: {}, assistants: [], providers: [], models: [], topics: [], folders: [], messages: [] }
}

function readJSON<T>(key: string, fallback: () => T): T | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return fallback()
  }
  if (!raw) return fallback()
  try {
    return JSON.parse(raw) as T
  } catch {
    // 损坏数据直接丢弃重来，避免脏状态在 UI 里表现为诡异错误。
    return fallback()
  }
}

function writeKey(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    throw new Error(`写入本地存储失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 读取（懒加载并缓存）整个数据库 blob；返回的引用只读，改动必须走 mutateDb。 */
export function loadDb(): WebDb {
  if (dbCache) return dbCache
  const raw = readJSON<Partial<WebDb>>(DB_KEY, emptyDb) ?? emptyDb()
  dbCache = {
    settings: raw.settings ?? {},
    assistants: raw.assistants ?? [],
    providers: raw.providers ?? [],
    models: raw.models ?? [],
    topics: raw.topics ?? [],
    folders: raw.folders ?? [],
    messages: raw.messages ?? [],
  }
  return dbCache
}

/**
 * 读-改-写：先克隆快照交给 fn 修改，fn 抛错则什么都不落盘（相当于回滚）；
 * 成功才写 localStorage 并替换缓存，保证内存与落盘一致。
 */
export function mutateDb<T>(fn: (db: WebDb) => T): T {
  const draft = JSON.parse(JSON.stringify(loadDb())) as WebDb
  const result = fn(draft)
  writeKey(DB_KEY, draft)
  dbCache = draft
  return result
}

function loadSecrets(): WebSecrets {
  if (secretsCache) return secretsCache
  const raw = readJSON<Partial<WebSecrets>>(SECRETS_KEY, () => ({ providers: {}, search: '' }))
  secretsCache = {
    providers: raw?.providers ?? {},
    search: raw?.search ?? '',
  }
  return secretsCache
}

function persistSecrets(next: WebSecrets): void {
  writeKey(SECRETS_KEY, next)
  secretsCache = next
}

export function getProviderKey(providerID: string): string {
  return loadSecrets().providers[providerID] ?? ''
}

/** 写入或清除（空串）某个 provider 的明文密钥。 */
export function setProviderKey(providerID: string, key: string): void {
  const secrets = loadSecrets()
  const providers = { ...secrets.providers }
  if (key) providers[providerID] = key
  else delete providers[providerID]
  persistSecrets({ providers, search: secrets.search })
}

export function getSearchKey(): string {
  return loadSecrets().search
}

export function setSearchKey(key: string): void {
  persistSecrets({ providers: { ...loadSecrets().providers }, search: key })
}

export function newId(): string {
  return crypto.randomUUID()
}

export function nowMs(): number {
  return Date.now()
}
