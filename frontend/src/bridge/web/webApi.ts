import type { AppApi } from '../appApi'
import type {
  AppSettingsDTO,
  AssistantDTO,
  BootstrapDTO,
  MessageDTO,
  ModelDTO,
  ModelSyncResultDTO,
  ProviderDTO,
  RelayStatusDTO,
  SearchResultDTO,
  SearchSettingsDTO,
  MarkdownExportDTO,
  TopicDTO,
  TopicFolderDTO,
  TreeNodeDTO,
} from '../../domain/dto'
import {
  getProviderKey,
  getSearchKey,
  loadDb,
  mutateDb,
  newId,
  nowMs,
  setProviderKey,
  setSearchKey,
} from './db'
import type {
  StoredAssistant,
  StoredMessage,
  StoredModel,
  StoredProvider,
  StoredTopic,
  StoredTopicFolder,
  WebDb,
} from './db'
import { exportMarkdown, sanitizeExportName } from './markdown'
import { webOutboundFetch } from './webFetch'

// 浏览器版 AppApi：逐方法对齐 internal/api/*.go 的语义（消息树、分支、话题目录、
// 模型同步、导出等），持久层换成 db.ts 的 localStorage blob。错误文案沿用 Go 侧中文。
// 按 SINGLE_HTML_WEB.md 的简化许可：跳过 UUID 严格校验，输入合法性由 UI 保证。

const APP_NAME = 'MyAIUI2'
const APP_VERSION = '0.1.0-prototype-web'

const DEFAULT_PROVIDER_KIND = 'openai-compatible'
const DEFAULT_MODEL_PATH = '/models'
const DEFAULT_ASSISTANT_NAME = '默认助手'
const DEFAULT_ASSISTANT_EMOJI = 'icon:sparkles:indigo'
const DEFAULT_TOPIC_TITLE = '新话题'
const DEFAULT_SEARCH_SERVICE = 'searxng'
const DEFAULT_MAX_RESULTS = 5
const MAX_SEARCH_RESULTS = 10
const DUPLICATE_TITLE_SUFFIX = '（副本）'

const SETTING_KEY_APP = 'app'
const SETTING_KEY_SEARCH = 'search'
const SETTING_KEY_PROXY = 'network_proxy'
// v2：v1 期间被删/缺失的内置助手再补种一次（同名跳过，补完写标记，之后仍可删）。
const SETTING_KEY_BUILTIN_ASSISTANTS = 'builtin_assistants_v2'
const SETTING_KEY_BUILTIN_EMOJI_V2 = 'builtin_assistants_emoji_v2'

const PREVIEW_PARTS_BYTES = 64 << 10
const PREVIEW_RUNE_LIMIT = 60
const MAX_DELETE_MESSAGES = 1000
const ERROR_TEXT_LIMIT = 300
const MAX_INTERNAL_BYTES = 8 << 20
const MAX_SEARCH_BYTES = 4 << 20

const MAX_NAME_LEN = 80
const MAX_TITLE_LEN = 120
const MAX_PROMPT_LEN = 8000
const MAX_MESSAGE_LEN = 32000
const MAX_REMOTE_ID_LEN = 200
const MAX_URL_LEN = 2048
const MAX_QUERY_LEN = 500
const MAX_PATH_LEN = 1024
const MAX_PARTS_BYTES = 256 * 1024

const PROVIDER_KINDS = new Set(['openai-compatible', 'openai', 'openai-responses'])
const MODALITIES = new Set(['text', 'image'])
const MESSAGE_STATUS = new Set(['pending', 'streaming', 'done', 'cancelled', 'error', 'interrupted'])
const FINAL_STATUS = new Set(['done', 'cancelled', 'error'])
const THEMES = new Set(['system', 'light', 'dark'])
const SEARCH_SERVICES = new Set(['searxng'])
const TOPIC_FOLDER_ZONES = new Set(['', 'fav'])
const RELAY_DISABLED: RelayStatusDTO = {
  Enabled: false,
  Running: false,
  Addr: '',
  PythonPath: '',
  Error: '',
}

/** 预置助手定义；一次性播种（对齐 app_api.go builtinAssistantSeeds）。 */
const BUILTIN_ASSISTANT_SEEDS: Array<{ Name: string; Emoji: string; SystemPrompt: string }> = [
  { Name: DEFAULT_ASSISTANT_NAME, Emoji: DEFAULT_ASSISTANT_EMOJI, SystemPrompt: '' },
  {
    Name: '编程助手',
    Emoji: 'icon:code:sky',
    SystemPrompt:
      '你是一个资深全栈编程助手，擅长前端（React/TypeScript）、后端（Go/Python/Node.js）与数据库设计。' +
      '回答时先简述思路与关键决策，再给出可直接使用的代码；代码遵循调用方项目的既有风格与约定；' +
      '必要时给出分步实施建议。',
  },
  {
    Name: '变量名命名大师',
    Emoji: 'icon:type:amber',
    SystemPrompt:
      '你是变量命名专家。用户会描述一个变量、函数、类或常量的用途、类型与上下文。' +
      '你给出 3~5 个命名建议，每个注明命名风格（camelCase/snake_case/PascalCase/UPPER_SNAKE_CASE）、含义与适用场景，' +
      '最后推荐一个最佳答案并说明理由。命名原则：准确表达意图、避免歧义缩写、符合目标语言惯例。',
  },
  {
    Name: '中英翻译',
    Emoji: 'icon:languages:teal',
    SystemPrompt:
      '你是专业的中英互译助手。自动判断输入语言：中文译成英文，英文译成中文。' +
      '保持原文语气、格式与专业术语的准确性；只输出译文，不输出解释或注释；' +
      '遇到一词多义时在译文后用括号给出备选译法。',
  },
]

/** 同步远端模型时的单条模型信息（对齐 repository.SyncedModel）。 */
interface SyncedModel {
  RemoteID: string
  DisplayName: string
  Modality: string
  CapabilitiesJSON: string
}

const textEncoder = new TextEncoder()

// ---------------------------------------------------------------- 小工具

function runes(value: string): string[] {
  return Array.from(value)
}

function foldSpaces(value: string): string {
  return value
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ')
}

function byteLen(value: string): number {
  return textEncoder.encode(value).length
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ''
}

function trimErrText(message: string): string {
  const clean = message.trim()
  if (!clean) return '未知错误'
  return runes(clean).length > ERROR_TEXT_LIMIT
    ? `${runes(clean).slice(0, ERROR_TEXT_LIMIT).join('')}…`
    : clean
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function validateTextLen(field: string, value: string, max: number): void {
  if (runes(value).length > max) throw new Error(`${field}长度不能超过 ${max} 个字符`)
}

function validateEnum(field: string, value: string, allowed: Set<string>): void {
  if (!allowed.has(value)) throw new Error(`${field}取值非法`)
}

/** 规范化服务地址：只允许 http/https，禁 userinfo/fragment，去路径尾部 `/`。 */
function normalizeBaseURL(raw: string): string {
  const value = raw.trim()
  if (!value) throw new Error('服务地址不能为空')
  if (runes(value).length > MAX_URL_LEN) throw new Error(`服务地址长度不能超过 ${MAX_URL_LEN} 个字符`)
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error('服务地址格式非法')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('服务地址只允许 http/https')
  if (u.username || u.password) throw new Error('服务地址不能包含用户名或密码')
  if (u.hash) throw new Error('服务地址不能包含 # 片段')
  if (!u.host) throw new Error('服务地址缺少主机名')
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

/** 外链校验：http/https、无 userinfo/fragment、有主机名；非法统一抛同一文案。 */
function validateExternalURL(raw: string): string {
  const value = raw.trim()
  const invalid = new Error('链接无效或不被允许')
  if (!value || value.length > MAX_URL_LEN) throw invalid
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw invalid
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid
  if (u.username || u.password) throw invalid
  if (u.hash) throw invalid
  if (!u.host || !u.hostname) throw invalid
  return u.toString()
}

function validateRelativePath(field: string, path: string): void {
  if (!path.trim()) throw new Error(`${field}不能为空`)
  if (runes(path).length > MAX_PATH_LEN) throw new Error(`${field}长度不能超过 ${MAX_PATH_LEN} 个字符`)
  if (path.startsWith('//')) throw new Error(`${field}不能以 // 开头`)
  if (path.includes('://')) throw new Error(`${field}必须是相对路径`)
  if (!path.startsWith('/')) throw new Error(`${field}必须以 / 开头`)
  if (path.includes('..')) throw new Error(`${field}不能包含 ..`)
}

function ensureLeadingSlash(path: string): string {
  return !path || path.startsWith('/') ? path : `/${path}`
}

/**
 * base+path 解析（对齐 transport.ResolveEndpoint）：BaseURL 自带路径前缀时，
 * path 没带前缀就拼上，避免出现 /v1/v1/..。
 */
function resolveEndpoint(baseURL: string, path: string): string {
  let base: URL
  try {
    base = new URL(baseURL)
  } catch {
    throw new Error('服务地址非法')
  }
  const ref = path.trim()
  if (!ref) throw new Error('请求路径不能为空')
  if (ref.length > 16 << 10) throw new Error('请求路径过长')
  if (!ref.startsWith('/')) throw new Error('请求路径必须是相对路径')
  if (ref.startsWith('//')) throw new Error('请求路径不允许以 // 开头')
  if (ref.includes('://')) throw new Error('请求路径不允许包含协议')
  if (ref.includes('#')) throw new Error('请求路径不允许包含锚点')
  if (ref.split('?')[0].split('/').includes('..')) throw new Error('请求路径不允许包含 ..')
  const prefix = base.pathname.replace(/\/+$/, '')
  const full = prefix && !(ref === prefix || ref.startsWith(`${prefix}/`)) ? prefix + ref : ref
  try {
    return new URL(full, base.origin).toString()
  } catch {
    throw new Error('请求路径非法')
  }
}

/** NormalizeProxyURL 的 JS 版：只支持 http 正向代理；空串 = 禁用。 */
function normalizeProxyURL(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  const invalid = new Error('代理地址格式错误，请填写 http://主机:端口，可包含用户名和密码')
  if (value.length > 4096 || /[\r\n\t]/.test(value)) throw invalid
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw invalid
  }
  if (u.protocol !== 'http:' || !u.hostname) throw invalid
  if ((u.pathname !== '' && u.pathname !== '/') || u.search || u.hash || value.includes('#')) {
    throw invalid
  }
  const port = u.port
  if (port) {
    const n = Number(port)
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw invalid
  }
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : ''
  return `http://${auth}${u.host}`
}

/** 图像模型的保守启发式（对齐 heuristicModality）：未知一律按文本。 */
const IMAGE_MODEL_HINTS = [
  'dall-e',
  'gpt-image',
  'flux',
  'stable-diffusion',
  'sd3',
  'imagen',
  'kolors',
  'seedream',
  'qwen-image',
  'cogview',
  'midjourney',
  'hidream',
  'janus',
]

function heuristicModality(remoteID: string): string {
  const lower = remoteID.toLowerCase()
  return IMAGE_MODEL_HINTS.some((hint) => lower.includes(hint)) ? 'image' : 'text'
}

/** 用户文本消息的 parts_json（对齐 textPartsJSON）。 */
function textPartsJSON(text: string): string {
  return JSON.stringify([{ type: 'text', text }])
}

/** 取用户文本前 30 字做话题标题（对齐 autoTitle）。 */
function autoTitle(text: string): string {
  const folded = foldSpaces(text)
  const chars = runes(folded)
  return chars.length > 30 ? chars.slice(0, 30).join('') : folded
}

/** 带超时的 fetch：超时按 AbortError 抛出，调用方转成「请求超时」。经 webOutboundFetch 中转（有代理走代理）。 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await webOutboundFetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** fetch 抛错 → 中文错误文本（AbortError 一律视为超时）。 */
function fetchErrorText(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return '请求超时'
  return errText(err)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

/** 对齐 http.DetectContentType 的常见图片魔数嗅探；不认识返回空串。 */
function sniffImageMime(bytes: Uint8Array): string {
  const ascii = (offset: number, len: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + len))
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') return 'image/gif'
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'image/vnd.microsoft.icon'
  }
  if (bytes.length >= 12 && ascii(4, 8) === 'ftypavif') return 'image/avif'
  return ''
}

async function copyToSystemClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    throw new Error('写入剪贴板失败')
  }
}

// ---------------------------------------------------------------- 集合访问（排序对齐各仓库 SQL）

function assistantsOf(db: WebDb): StoredAssistant[] {
  return [...db.assistants].sort((a, b) => a.SortOrder - b.SortOrder || a.CreatedAt - b.CreatedAt)
}

function providersOf(db: WebDb): StoredProvider[] {
  return [...db.providers].sort((a, b) => a.CreatedAt - b.CreatedAt || cmpStr(a.ID, b.ID))
}

function modelsOf(db: WebDb, providerID: string): StoredModel[] {
  const list = db.models.filter((m) => providerID === '' || m.ProviderID === providerID)
  if (providerID === '') {
    list.sort(
      (a, b) =>
        cmpStr(a.ProviderID, b.ProviderID) || cmpStr(a.DisplayName, b.DisplayName) || cmpStr(a.ID, b.ID),
    )
  } else {
    list.sort((a, b) => cmpStr(a.DisplayName, b.DisplayName) || cmpStr(a.ID, b.ID))
  }
  return list
}

function topicsOf(db: WebDb, assistantID: string): StoredTopic[] {
  return db.topics
    .filter((t) => t.AssistantID === assistantID)
    .sort((a, b) => b.UpdatedAt - a.UpdatedAt || b.CreatedAt - a.CreatedAt)
}

function messagesOf(db: WebDb, topicID: string): StoredMessage[] {
  return db.messages.filter((m) => m.TopicID === topicID).sort((a, b) => a.SortOrder - b.SortOrder)
}

function foldersOf(db: WebDb, assistantID: string): StoredTopicFolder[] {
  return db.folders
    .filter((f) => f.AssistantID === assistantID)
    .sort((a, b) => cmpStr(a.Zone, b.Zone) || a.SortOrder - b.SortOrder)
}

function folderChildren(db: WebDb, assistantID: string, parentID: string, zone: string): StoredTopicFolder[] {
  return db.folders
    .filter((f) => f.AssistantID === assistantID && f.ParentID === parentID && f.Zone === zone)
    .sort((a, b) => a.SortOrder - b.SortOrder || a.UpdatedAt - b.UpdatedAt)
}

function topicSiblings(db: WebDb, assistantID: string, folderID: string, favorite: boolean): StoredTopic[] {
  return db.topics
    .filter(
      (t) => t.AssistantID === assistantID && t.FolderID === folderID && t.Favorite === favorite,
    )
    .sort((a, b) => a.SortOrder - b.SortOrder || a.UpdatedAt - b.UpdatedAt)
}

function getProvider(db: WebDb, id: string): StoredProvider | undefined {
  return db.providers.find((p) => p.ID === id)
}
function mustProvider(db: WebDb, id: string): StoredProvider {
  const provider = getProvider(db, id)
  if (!provider) throw new Error('模型服务不存在')
  return provider
}
function getModel(db: WebDb, id: string): StoredModel | undefined {
  return db.models.find((m) => m.ID === id)
}
function mustModel(db: WebDb, id: string): StoredModel {
  const model = getModel(db, id)
  if (!model) throw new Error('模型不存在')
  return model
}
function getAssistant(db: WebDb, id: string): StoredAssistant | undefined {
  return db.assistants.find((a) => a.ID === id)
}
function mustAssistant(db: WebDb, id: string): StoredAssistant {
  const assistant = getAssistant(db, id)
  if (!assistant) throw new Error('助手不存在')
  return assistant
}
function getTopic(db: WebDb, id: string): StoredTopic | undefined {
  return db.topics.find((t) => t.ID === id)
}
function mustTopic(db: WebDb, id: string): StoredTopic {
  const topic = getTopic(db, id)
  if (!topic) throw new Error('话题不存在')
  return topic
}
function getMessage(db: WebDb, id: string): StoredMessage | undefined {
  return db.messages.find((m) => m.ID === id)
}
function mustFolder(db: WebDb, id: string): StoredTopicFolder {
  const folder = db.folders.find((f) => f.ID === id)
  if (!folder) throw new Error('话题目录不存在')
  return folder
}

// ---------------------------------------------------------------- DTO 转换

function toProviderDTO(db: WebDb, p: StoredProvider | undefined): ProviderDTO {
  if (!p) {
    return {
      ID: '', Name: '', Kind: '', BaseURL: '', Enabled: false, ModelPath: '',
      HasAPIKey: false, CreatedAt: 0, UpdatedAt: 0, LastSyncAt: 0, LastSyncError: '', ModelCount: 0,
    }
  }
  return {
    ID: p.ID,
    Name: p.Name,
    Kind: p.Kind,
    BaseURL: p.BaseURL,
    Enabled: p.Enabled,
    ModelPath: p.ModelPath,
    HasAPIKey: getProviderKey(p.ID) !== '',
    CreatedAt: p.CreatedAt,
    UpdatedAt: p.UpdatedAt,
    LastSyncAt: p.LastSyncAt,
    LastSyncError: p.LastSyncError,
    ModelCount: db.models.filter((m) => m.ProviderID === p.ID).length,
  }
}

function toModelDTO(m: StoredModel | undefined): ModelDTO {
  if (!m) {
    return {
      ID: '', ProviderID: '', RemoteID: '', DisplayName: '', Modality: '',
      CapabilitiesJSON: '', Source: '', Enabled: false, MissingRemote: false, LastSeenAt: 0,
    }
  }
  return {
    ID: m.ID,
    ProviderID: m.ProviderID,
    RemoteID: m.RemoteID,
    DisplayName: m.DisplayName,
    Modality: m.Modality,
    CapabilitiesJSON: m.CapabilitiesJSON,
    Source: m.Source,
    Enabled: m.Enabled,
    MissingRemote: m.MissingRemote,
    LastSeenAt: m.LastSeenAt,
  }
}

function toAssistantDTO(a: StoredAssistant | undefined): AssistantDTO {
  if (!a) {
    return {
      ID: '', Name: '', Emoji: '', SystemPrompt: '', ProviderID: '', ModelID: '',
      Temperature: 0, TemperatureSet: false, WebSearchDefault: false,
      SortOrder: 0, CreatedAt: 0, UpdatedAt: 0,
    }
  }
  return {
    ID: a.ID,
    Name: a.Name,
    Emoji: a.Emoji,
    SystemPrompt: a.SystemPrompt,
    ProviderID: a.ProviderID,
    ModelID: a.ModelID,
    Temperature: a.Temperature,
    TemperatureSet: a.TemperatureSet,
    WebSearchDefault: a.WebSearchDefault,
    SortOrder: a.SortOrder,
    CreatedAt: a.CreatedAt,
    UpdatedAt: a.UpdatedAt,
  }
}

function toTopicDTO(t: StoredTopic, messageCount: number, hasBranches: boolean): TopicDTO {
  return {
    ID: t.ID,
    AssistantID: t.AssistantID,
    Title: t.Title,
    MessageCount: messageCount,
    ActiveNodeID: t.ActiveNodeID,
    HasBranches: hasBranches,
    FolderID: t.FolderID,
    Favorite: t.Favorite,
    SortOrder: t.SortOrder,
    CreatedAt: t.CreatedAt,
    UpdatedAt: t.UpdatedAt,
  }
}

function toTopicFolderDTO(f: StoredTopicFolder): TopicFolderDTO {
  return {
    ID: f.ID,
    AssistantID: f.AssistantID,
    ParentID: f.ParentID,
    Name: f.Name,
    Zone: f.Zone,
    SortOrder: f.SortOrder,
    CreatedAt: f.CreatedAt,
    UpdatedAt: f.UpdatedAt,
  }
}

function toMessageDTO(m: StoredMessage): MessageDTO {
  return {
    ID: m.ID,
    TopicID: m.TopicID,
    Role: m.Role,
    Status: m.Status,
    PartsJSON: m.PartsJSON,
    ProviderID: m.ProviderID,
    ModelRemoteID: m.ModelRemoteID,
    ParentID: m.ParentID,
    SortOrder: m.SortOrder,
    SiblingCount: 1,
    SiblingIndex: 1,
    CreatedAt: m.CreatedAt,
    UpdatedAt: m.UpdatedAt,
  }
}

// ---------------------------------------------------------------- 消息树（对齐 app_api.go 末尾的 helper）

function findMessage(all: StoredMessage[], id: string): StoredMessage | undefined {
  return all.find((m) => m.ID === id)
}

/** 沿 ParentID 从 nodeID 上溯到根并反转；nodeID 为空/找不到/断链返回 []（对齐 pathTo 的 nil）。 */
function pathTo(all: StoredMessage[], nodeID: string): StoredMessage[] {
  if (!nodeID) return []
  const byID = new Map(all.map((m) => [m.ID, m]))
  const path: StoredMessage[] = []
  const visited = new Set<string>()
  for (let current = nodeID; current !== ''; ) {
    if (visited.has(current)) break
    const m = byID.get(current)
    if (!m) return []
    visited.add(current)
    path.push(m)
    current = m.ParentID
  }
  return path.reverse()
}

function activePath(topic: StoredTopic, all: StoredMessage[]): StoredMessage[] {
  return pathTo(all, topic.ActiveNodeID)
}

/** path 消息转 DTO，并按 all（同话题全量）补齐兄弟序号（同一 ParentID 按 SortOrder、1 起）。 */
function pathMessageDTOs(path: StoredMessage[], all: StoredMessage[]): MessageDTO[] {
  const groups = new Map<string, StoredMessage[]>()
  for (const m of all) {
    const list = groups.get(m.ParentID)
    if (list) list.push(m)
    else groups.set(m.ParentID, [m])
  }
  return path.map((m) => {
    const dto = toMessageDTO(m)
    const group = groups.get(m.ParentID)
    if (!group || group.length === 0) return dto
    dto.SiblingCount = group.length
    const index = group.findIndex((sibling) => sibling.ID === m.ID)
    if (index >= 0) dto.SiblingIndex = index + 1
    return dto
  })
}

function siblingMessageDTO(all: StoredMessage[], m: StoredMessage): MessageDTO {
  const dtos = pathMessageDTOs([m], all)
  return dtos.length ? dtos[0] : toMessageDTO(m)
}

/** 集合中是否存在分支（同一 ParentID 下多于一条消息）。 */
function branchesIn(all: StoredMessage[]): boolean {
  const seen = new Map<string, number>()
  for (const m of all) {
    const count = (seen.get(m.ParentID) ?? 0) + 1
    if (count > 1) return true
    seen.set(m.ParentID, count)
  }
  return false
}

/** 下一个 sort_order（空话题从 1 开始）。 */
function nextSortOrder(all: StoredMessage[]): number {
  let max = 0
  for (const m of all) if (m.SortOrder > max) max = m.SortOrder
  return max + 1
}

/** 分支面板文本摘要：超大 parts_json 放弃解析，取不到文本返回 ''。 */
function previewFromParts(partsJSON: string): string {
  if (partsJSON.length > PREVIEW_PARTS_BYTES) return ''
  let parts: Array<{ type?: string; text?: string }>
  try {
    const parsed = JSON.parse(partsJSON) as unknown
    if (!Array.isArray(parsed)) return ''
    parts = parsed as Array<{ type?: string; text?: string }>
  } catch {
    return ''
  }
  for (const part of parts) {
    if (part?.type !== 'text') continue
    const folded = foldSpaces(part.text ?? '')
    if (!folded) continue
    const chars = runes(folded)
    return chars.length > PREVIEW_RUNE_LIMIT ? `${chars.slice(0, PREVIEW_RUNE_LIMIT).join('')}…` : folded
  }
  return ''
}

/** 话题 + 全部消息 + 活动路径（对齐 loadTopicPath）。 */
function loadTopicPath(
  db: WebDb,
  topicID: string,
): { topic: StoredTopic; all: StoredMessage[]; path: StoredMessage[] } {
  const topic = mustTopic(db, topicID)
  const all = messagesOf(db, topic.ID)
  return { topic, all, path: activePath(topic, all) }
}

// ---------------------------------------------------------------- 设置

function loadAppSettings(db: WebDb): AppSettingsDTO {
  const fallback: AppSettingsDTO = { ActiveAssistantID: '', ActiveTopicID: '', Theme: 'system' }
  const raw = db.settings[SETTING_KEY_APP]
  if (!raw || !raw.trim()) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettingsDTO>
    return {
      ActiveAssistantID: parsed.ActiveAssistantID ?? '',
      ActiveTopicID: parsed.ActiveTopicID ?? '',
      Theme: parsed.Theme || 'system',
    }
  } catch {
    return fallback
  }
}

function saveAppSettings(db: WebDb, settings: AppSettingsDTO): void {
  db.settings[SETTING_KEY_APP] = JSON.stringify(settings)
}

function getSearchSettings(db: WebDb): SearchSettingsDTO {
  const dto: SearchSettingsDTO = {
    Enabled: false,
    ServiceID: DEFAULT_SEARCH_SERVICE,
    BaseURL: '',
    HasAPIKey: false,
    MaxResults: DEFAULT_MAX_RESULTS,
  }
  const raw = db.settings[SETTING_KEY_SEARCH]
  if (raw && raw.trim()) {
    try {
      const stored = JSON.parse(raw) as {
        Enabled?: boolean
        ServiceID?: string
        BaseURL?: string
        MaxResults?: number
      }
      dto.Enabled = !!stored.Enabled
      dto.ServiceID = stored.ServiceID ?? ''
      dto.BaseURL = stored.BaseURL ?? ''
      dto.MaxResults = stored.MaxResults ?? 0
    } catch {
      /* 解析失败保持默认 */
    }
  }
  if (!dto.ServiceID) dto.ServiceID = DEFAULT_SEARCH_SERVICE
  if (dto.MaxResults <= 0) dto.MaxResults = DEFAULT_MAX_RESULTS
  if (dto.MaxResults > MAX_SEARCH_RESULTS) dto.MaxResults = MAX_SEARCH_RESULTS
  dto.HasAPIKey = getSearchKey() !== ''
  return dto
}

// ---------------------------------------------------------------- 启动播种

function createDefaultAssistant(db: WebDb, sortOrder: number): StoredAssistant {
  const now = nowMs()
  const assistant: StoredAssistant = {
    ID: newId(),
    Name: DEFAULT_ASSISTANT_NAME,
    Emoji: DEFAULT_ASSISTANT_EMOJI,
    SystemPrompt: '',
    ProviderID: '',
    ModelID: '',
    Temperature: 0,
    TemperatureSet: false,
    WebSearchDefault: false,
    SortOrder: sortOrder,
    CreatedAt: now,
    UpdatedAt: now,
  }
  db.assistants.push(assistant)
  return assistant
}

/** 预置助手「旧图标 → 新图标规格」（icon:<lucide>:<配色>，对齐 builtinEmojiUpgrade）。 */
const BUILTIN_EMOJI_UPGRADE: Record<string, [string, string]> = {
  [DEFAULT_ASSISTANT_NAME]: ['🤖', 'icon:sparkles:indigo'],
  编程助手: ['💻', 'icon:code:sky'],
  变量名命名大师: ['🏷️', 'icon:type:amber'],
  中英翻译: ['🔁', 'icon:languages:teal'],
}

/** 一次性把仍是旧图标的预置助手换新；名字与旧图标都命中才改，用户改过的图标不动。 */
function migrateBuiltinAssistantEmojis(db: WebDb): void {
  if (db.settings[SETTING_KEY_BUILTIN_EMOJI_V2]) return
  const now = nowMs()
  for (const a of db.assistants) {
    const up = BUILTIN_EMOJI_UPGRADE[a.Name]
    if (up && a.Emoji === up[0]) {
      a.Emoji = up[1]
      a.UpdatedAt = now
    }
  }
  db.settings[SETTING_KEY_BUILTIN_EMOJI_V2] = '"1"'
}

/** 预置助手只播种一次；同名已存在则跳过（对齐 ensureBuiltinAssistants）。 */
function ensureBuiltinAssistants(db: WebDb): void {
  if (db.settings[SETTING_KEY_BUILTIN_ASSISTANTS]) return
  const existing = new Set(db.assistants.map((a) => a.Name))
  const now = nowMs()
  BUILTIN_ASSISTANT_SEEDS.forEach((seed, order) => {
    if (existing.has(seed.Name)) return
    db.assistants.push({
      ID: newId(),
      Name: seed.Name,
      Emoji: seed.Emoji,
      SystemPrompt: seed.SystemPrompt,
      ProviderID: '',
      ModelID: '',
      Temperature: 0,
      TemperatureSet: false,
      WebSearchDefault: false,
      SortOrder: order,
      CreatedAt: now,
      UpdatedAt: now,
    })
    existing.add(seed.Name)
  })
  db.settings[SETTING_KEY_BUILTIN_ASSISTANTS] = '"1"'
}

function createTopic(db: WebDb, assistantID: string, title: string): StoredTopic {
  const now = nowMs()
  const topic: StoredTopic = {
    ID: newId(),
    AssistantID: assistantID,
    Title: title,
    ActiveNodeID: '',
    FolderID: '',
    Favorite: false,
    SortOrder: 0,
    CreatedAt: now,
    UpdatedAt: now,
  }
  db.topics.push(topic)
  return topic
}

function listTopicDTOs(db: WebDb, assistantID: string) {
  // 消息数与分支标记一次批量算出（对齐 CountMessages + HasBranchesByAssistant）。
  const counts = new Map<string, number>()
  const parentSets = new Map<string, Set<string>>()
  for (const m of db.messages) {
    counts.set(m.TopicID, (counts.get(m.TopicID) ?? 0) + 1)
    const parents = parentSets.get(m.TopicID) ?? new Set<string>()
    parents.add(m.ParentID)
    parentSets.set(m.TopicID, parents)
  }
  return topicsOf(db, assistantID).map((t) => {
    const count = counts.get(t.ID) ?? 0
    const branched = count > (parentSets.get(t.ID)?.size ?? 0)
    return toTopicDTO(t, count, branched)
  })
}

/** 无话题时补一个默认「新话题」（幂等）。 */
function ensureTopics(db: WebDb, assistantID: string) {
  const topics = listTopicDTOs(db, assistantID)
  if (topics.length > 0) return topics
  createTopic(db, assistantID, DEFAULT_TOPIC_TITLE)
  return listTopicDTOs(db, assistantID)
}

function pickAssistantID(assistants: AssistantDTO[], want: string): string {
  if (assistants.some((a) => a.ID === want)) return want
  return assistants[0]?.ID ?? ''
}

function pickTopicID(topics: Array<{ ID: string }>, want: string): string {
  if (topics.some((t) => t.ID === want)) return want
  return topics[0]?.ID ?? ''
}

// ---------------------------------------------------------------- 会话目标解析（对齐 resolveTurnTarget）

interface TurnTarget {
  provider?: StoredProvider
  model?: StoredModel
  providerID: string
  remoteID: string
}

function resolveTurnTarget(
  db: WebDb,
  providerID: string,
  modelID: string,
  remoteID: string,
  modality: string,
): TurnTarget {
  const pid = providerID.trim()
  const provider = pid ? mustProvider(db, pid) : undefined
  const mid = modelID.trim()
  const model = mid ? mustModel(db, mid) : undefined
  const resolvedProviderID = pid || model?.ProviderID || ''
  const resolvedRemoteID = remoteID.trim() || model?.RemoteID || ''
  validateTextLen('远端模型 ID', resolvedRemoteID, MAX_REMOTE_ID_LEN)
  const value = modality.trim() || model?.Modality || ''
  if (value) validateEnum('模型类型', value, MODALITIES)
  return { provider, model, providerID: resolvedProviderID, remoteID: resolvedRemoteID }
}

/** 话题所属助手；已删除时返回 undefined（DTO 走零值，只影响展示）。 */
function assistantOf(db: WebDb, topic: StoredTopic): StoredAssistant | undefined {
  return topic.AssistantID ? getAssistant(db, topic.AssistantID) : undefined
}

function modelPathOf(p: StoredProvider): string {
  return ensureLeadingSlash(p.ModelPath.trim() || DEFAULT_MODEL_PATH)
}

/** 解析远端模型列表：兼容 {"data":[...]} 与 {"models":[...]}（对齐 parseRemoteModels）。 */
function parseRemoteModels(body: string): SyncedModel[] {
  let payload: { data?: unknown; models?: unknown }
  try {
    payload = JSON.parse(body) as { data?: unknown; models?: unknown }
  } catch {
    return []
  }
  const data = Array.isArray(payload?.data) ? payload.data : []
  const entries = data.length ? data : Array.isArray(payload?.models) ? payload.models : []
  const out: SyncedModel[] = []
  const seen = new Set<string>()
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  for (const entry of entries) {
    if (typeof entry === 'string') {
      const raw = entry.trim()
      if (!raw || seen.has(raw)) continue
      seen.add(raw)
      out.push({ RemoteID: raw, DisplayName: raw, Modality: heuristicModality(raw), CapabilitiesJSON: '{}' })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as {
      id?: unknown
      name?: unknown
      model?: unknown
      display_name?: unknown
      root?: unknown
    }
    const remoteID = firstNonEmpty(str(item.id), str(item.model), str(item.name), str(item.root))
    if (!remoteID || runes(remoteID).length > MAX_REMOTE_ID_LEN || seen.has(remoteID)) continue
    seen.add(remoteID)
    let displayName = firstNonEmpty(str(item.display_name), str(item.name), str(item.model), remoteID)
    if (runes(displayName).length > MAX_TITLE_LEN) displayName = remoteID
    out.push({
      RemoteID: remoteID,
      DisplayName: displayName,
      Modality: heuristicModality(remoteID),
      CapabilitiesJSON: '{}',
    })
  }
  return out
}

/** 内部 GET（模型列表/连通性探测）共用：解析地址 + 鉴权头。 */
function providerGetInit(apiKey: string): RequestInit {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return { headers }
}

/** 校验 parts_json：JSON 数组且 ≤256KB（对齐 validatePartsJSON）。 */
function validatePartsJSON(field: string, raw: string): void {
  const value = raw.trim()
  if (!value) throw new Error(`${field}不能为空`)
  if (byteLen(raw) > MAX_PARTS_BYTES) throw new Error(`${field}不能超过 256KB`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${field}必须是 JSON 数组`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${field}必须是 JSON 数组`)
}

/** 把元素从列表中取出并插到 index 下标处（对齐 reorderTopic/reorderTopicFolder）。 */
function reorderById<T extends { ID: string }>(list: T[], id: string, index: number): T[] {
  const moved = list.find((item) => item.ID === id)
  if (!moved) return list
  const rest = list.filter((item) => item.ID !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, at), moved, ...rest.slice(at)]
}

/** 目录祖先链检查：沿 ParentID 上溯是否含 targetID（对齐 folderAncestorHas）。 */
function folderAncestorHas(db: WebDb, assistantID: string, startID: string, targetID: string): boolean {
  if (!startID || !targetID) return false
  const byID = new Map(
    db.folders.filter((f) => f.AssistantID === assistantID).map((f) => [f.ID, f]),
  )
  const visited = new Set<string>()
  for (let current = startID; current !== ''; ) {
    if (current === targetID) return true
    if (visited.has(current)) break
    visited.add(current)
    const folder = byID.get(current)
    if (!folder) break
    current = folder.ParentID
  }
  return false
}

function validateFolderParent(
  db: WebDb,
  assistantID: string,
  parentID: string,
  zone: string,
  folderID: string,
): void {
  const parent = db.folders.find((f) => f.ID === parentID)
  if (!parent) throw new Error('父目录不存在')
  if (parent.AssistantID !== assistantID) throw new Error('父目录不属于该助手')
  if (parent.Zone !== zone) throw new Error('父目录与目标区域不一致')
  if (folderAncestorHas(db, assistantID, parentID, folderID)) {
    throw new Error('不能把目录放到自身或其子目录下')
  }
}

/** 删除服务/模型前解除助手的外键引用（对齐 clearAssistantReferences）。 */
function clearAssistantReferences(db: WebDb, removedID: string, providerScope: boolean): void {
  const providerModels = providerScope
    ? new Set(db.models.filter((m) => m.ProviderID === removedID).map((m) => m.ID))
    : null
  const now = nowMs()
  for (const assistant of db.assistants) {
    let changed = false
    if (providerScope && assistant.ProviderID === removedID) {
      assistant.ProviderID = ''
      assistant.ModelID = ''
      changed = true
    } else if (assistant.ModelID === removedID) {
      assistant.ModelID = ''
      changed = true
    } else if (providerModels && assistant.ModelID && providerModels.has(assistant.ModelID)) {
      assistant.ModelID = ''
      changed = true
    }
    if (changed) assistant.UpdatedAt = now
  }
}

/** 删除助手后维持「至少一个助手 + 活动指针有效」的不变量（对齐 restoreAssistantInvariant）。 */
function restoreAssistantInvariant(db: WebDb, deletedID: string): void {
  const list = assistantsOf(db)
  const settings = loadAppSettings(db)
  if (list.length === 0) {
    const assistant = createDefaultAssistant(db, 0)
    const topic = createTopic(db, assistant.ID, DEFAULT_TOPIC_TITLE)
    settings.ActiveAssistantID = assistant.ID
    settings.ActiveTopicID = topic.ID
    saveAppSettings(db, settings)
    return
  }
  if (settings.ActiveAssistantID === deletedID || !list.some((a) => a.ID === settings.ActiveAssistantID)) {
    settings.ActiveAssistantID = list[0].ID
    settings.ActiveTopicID = ''
    saveAppSettings(db, settings)
  }
}

/** 子树并集删除（对齐 DeleteMessages）；返回实际删除条数。 */
function deleteMessagesImpl(ids: string[]): number {
  return mutateDb((db) => {
    if (ids.length === 0) throw new Error('消息 ID 列表不能为空')
    if (ids.length > MAX_DELETE_MESSAGES) throw new Error('单次最多删除 1000 条消息')
    const roots = new Set(ids.map((id) => id.trim()))
    const firstID = roots.values().next().value as string
    const first = getMessage(db, firstID)
    if (!first) throw new Error('消息不存在')
    const topic = mustTopic(db, first.TopicID)
    const all = messagesOf(db, topic.ID)
    const byID = new Map(all.map((m) => [m.ID, m]))
    const children = new Map<string, string[]>()
    for (const m of all) {
      const list = children.get(m.ParentID)
      if (list) list.push(m.ID)
      else children.set(m.ParentID, [m.ID])
    }
    for (const id of roots) {
      if (!byID.has(id)) throw new Error('消息不存在')
    }

    // 从每个请求 id 向下收集全部后代。
    const deleted = new Set<string>()
    const queue = [...roots]
    while (queue.length > 0) {
      const id = queue.pop() as string
      if (deleted.has(id)) continue
      deleted.add(id)
      queue.push(...(children.get(id) ?? []))
    }

    // 活动节点被删时上溯父链找最近存活祖先；整棵被删则回到根（空）。
    let newActive = topic.ActiveNodeID
    if (deleted.has(topic.ActiveNodeID)) {
      newActive = ''
      for (let current = byID.get(topic.ActiveNodeID)?.ParentID ?? ''; current !== ''; ) {
        const parent = byID.get(current)
        if (!parent) break
        if (!deleted.has(current)) {
          newActive = current
          break
        }
        current = parent.ParentID
      }
    }

    db.messages = db.messages.filter((m) => !deleted.has(m.ID))
    if (newActive !== topic.ActiveNodeID) {
      topic.ActiveNodeID = newActive
      topic.UpdatedAt = nowMs()
    }
    return deleted.size
  })
}

/** 渲染导出正文（对齐 ExportTopicMarkdown）。 */
function exportTopicMarkdownImpl(db: WebDb, topicID: string): MarkdownExportDTO {
  const topic = mustTopic(db, topicID.trim())
  const all = messagesOf(db, topic.ID)
  const path = activePath(topic, all)
  const assistant = topic.AssistantID ? (getAssistant(db, topic.AssistantID) ?? null) : null
  const now = new Date()
  const rendered = exportMarkdown(topic, path, assistant, now)
  return {
    TopicID: topic.ID,
    FileName: rendered.fileName,
    Markdown: rendered.markdown,
    MessageCount: path.length,
  }
}

// ---------------------------------------------------------------- API 实现

export const webApi: AppApi = {
  Bootstrap: async () =>
    mutateDb((db): BootstrapDTO => {
      const now = nowMs()
      // 对齐 Start()：上次留下的生成中消息标记 interrupted。
      for (const m of db.messages) {
        if (m.Status === 'pending' || m.Status === 'streaming') {
          m.Status = 'interrupted'
          m.UpdatedAt = now
        }
      }
      if (db.assistants.length === 0) createDefaultAssistant(db, 0)
      ensureBuiltinAssistants(db)
      migrateBuiltinAssistantEmojis(db)
      const assistants = assistantsOf(db).map((a) => toAssistantDTO(a))
      const settings = loadAppSettings(db)
      const activeAssistantID = pickAssistantID(assistants, settings.ActiveAssistantID)
      const topics = ensureTopics(db, activeAssistantID)
      const activeTopicID = pickTopicID(topics, settings.ActiveTopicID)
      if (settings.ActiveAssistantID !== activeAssistantID || settings.ActiveTopicID !== activeTopicID) {
        settings.ActiveAssistantID = activeAssistantID
        settings.ActiveTopicID = activeTopicID
        saveAppSettings(db, settings)
      }
      return {
        AppName: APP_NAME,
        Version: APP_VERSION,
        Settings: settings,
        Assistants: assistants,
        Providers: providersOf(db).map((p) => toProviderDTO(db, p)),
        Models: modelsOf(db, '').map(toModelDTO),
        Topics: topics,
        Search: getSearchSettings(db),
      }
    }),

  ListProviders: async () => providersOf(loadDb()).map((p) => toProviderDTO(loadDb(), p)),

  SaveProvider: async (input) =>
    mutateDb((db) => {
      const name = input.Name.trim()
      if (!name) throw new Error('服务名称不能为空')
      validateTextLen('服务名称', name, MAX_NAME_LEN)
      const kind = input.Kind.trim() || DEFAULT_PROVIDER_KIND
      validateEnum('服务类型', kind, PROVIDER_KINDS)
      const baseURL = normalizeBaseURL(input.BaseURL)
      const modelPath = ensureLeadingSlash(input.ModelPath.trim() || DEFAULT_MODEL_PATH)
      validateRelativePath('模型列表路径', modelPath)

      const now = nowMs()
      let provider: StoredProvider
      if (!input.ID.trim()) {
        provider = {
          ID: newId(),
          Name: '',
          Kind: '',
          BaseURL: '',
          Enabled: false,
          ModelPath: '',
          CreatedAt: now,
          UpdatedAt: now,
          LastSyncAt: 0,
          LastSyncError: '',
        }
        db.providers.push(provider)
      } else {
        provider = mustProvider(db, input.ID.trim())
      }
      provider.Name = name
      provider.Kind = kind
      provider.BaseURL = baseURL
      provider.ModelPath = modelPath
      provider.Enabled = input.Enabled
      provider.UpdatedAt = now

      // 密钥存独立 secrets key：非空覆盖，ClearAPIKey 清空，其余保留。
      if (input.ClearAPIKey) setProviderKey(provider.ID, '')
      else if (input.APIKey.trim()) setProviderKey(provider.ID, input.APIKey)

      return toProviderDTO(db, provider)
    }),

  DeleteProvider: async (id) => {
    const providerID = id.trim()
    mutateDb((db) => {
      clearAssistantReferences(db, providerID, true)
      const index = db.providers.findIndex((p) => p.ID === providerID)
      if (index < 0) throw new Error('模型服务不存在')
      db.providers.splice(index, 1)
      // 对齐 schema 的 ON DELETE CASCADE：模型随服务一起删。
      db.models = db.models.filter((m) => m.ProviderID !== providerID)
    })
    setProviderKey(providerID, '')
  },

  TestProvider: async (id) => {
    const provider = mustProvider(loadDb(), id.trim())
    if (!provider.BaseURL.trim()) {
      return { OK: false, LatencyMs: 0, Message: '该服务未配置地址', ModelCount: 0 }
    }
    let endpoint: string
    try {
      endpoint = resolveEndpoint(provider.BaseURL, modelPathOf(provider))
    } catch (err) {
      return { OK: false, LatencyMs: 0, Message: trimErrText(errText(err)), ModelCount: 0 }
    }
    const start = Date.now()
    try {
      const resp = await fetchWithTimeout(endpoint, providerGetInit(getProviderKey(provider.ID)), 10_000)
      const latency = Date.now() - start
      if (!resp.ok) {
        return {
          OK: false,
          LatencyMs: latency,
          Message: `服务返回 HTTP ${resp.status} ${resp.statusText.trim()}`,
          ModelCount: 0,
        }
      }
      const body = await resp.text().catch(() => '')
      const items = parseRemoteModels(body)
      const message = items.length > 0 ? `连接成功，检测到 ${items.length} 个模型` : '连接成功'
      return { OK: true, LatencyMs: latency, Message: message, ModelCount: items.length }
    } catch (err) {
      return { OK: false, LatencyMs: Date.now() - start, Message: trimErrText(fetchErrorText(err)), ModelCount: 0 }
    }
  },

  SyncProviderModels: async (id) => {
    const providerID = id.trim()
    const result: ModelSyncResultDTO = {
      Added: 0,
      Updated: 0,
      Missing: 0,
      Total: 0,
      DurationMs: 0,
      Error: '',
      Models: [],
      AddedIDs: [],
    }
    const provider = mustProvider(loadDb(), providerID)
    const start = Date.now()
    const fail = (message: string): ModelSyncResultDTO => {
      const trimmed = trimErrText(message)
      const models = mutateDb((db) => {
        const p = getProvider(db, providerID)
        if (p) {
          p.LastSyncAt = nowMs()
          p.LastSyncError = trimmed
        }
        return modelsOf(db, providerID).map(toModelDTO)
      })
      result.Error = trimmed
      result.DurationMs = Date.now() - start
      result.Models = models
      result.Total = models.length
      return result
    }

    if (!provider.BaseURL.trim()) return fail('该服务未配置地址')
    let endpoint: string
    try {
      endpoint = resolveEndpoint(provider.BaseURL, modelPathOf(provider))
    } catch (err) {
      return fail(errText(err))
    }
    let resp: Response
    try {
      resp = await fetchWithTimeout(endpoint, providerGetInit(getProviderKey(provider.ID)), 30_000)
    } catch (err) {
      return fail(fetchErrorText(err))
    }
    if (!resp.ok) return fail(`服务返回 HTTP ${resp.status} ${resp.statusText.trim()}`)
    const body = await resp.text().catch(() => '')
    if (byteLen(body) > MAX_INTERNAL_BYTES) return fail('响应内容过大')
    const items = parseRemoteModels(body)
    if (items.length === 0) return fail('服务未返回任何模型')

    const synced = mutateDb((db) => {
      const now = nowMs()
      const addedIDs: string[] = []
      let updated = 0
      // UpsertSynced：已存在的 synced 行更新展示信息；manual 行不动；否则新插（默认未启用）。
      const providerModels = db.models.filter((m) => m.ProviderID === providerID)
      for (const item of items) {
        const existing = providerModels.find((m) => m.RemoteID === item.RemoteID)
        if (existing && existing.Source === 'synced') {
          existing.DisplayName = item.DisplayName || item.RemoteID
          existing.Modality = item.Modality || 'text'
          existing.LastSeenAt = now
          existing.MissingRemote = false
          updated += 1
          continue
        }
        if (existing) continue
        const model: StoredModel = {
          ID: newId(),
          ProviderID: providerID,
          RemoteID: item.RemoteID,
          DisplayName: item.DisplayName || item.RemoteID,
          Modality: item.Modality || 'text',
          CapabilitiesJSON: item.CapabilitiesJSON || '{}',
          Source: 'synced',
          Enabled: false,
          MissingRemote: false,
          LastSeenAt: now,
        }
        db.models.push(model)
        providerModels.push(model)
        addedIDs.push(model.ID)
      }
      // MarkMissing：本次未返回的 synced 模型标失联（manual 永不动）。
      const seen = new Set(items.map((item) => item.RemoteID))
      let missing = 0
      for (const m of providerModels) {
        if (m.Source === 'synced' && !seen.has(m.RemoteID)) {
          m.MissingRemote = true
          missing += 1
        }
      }
      const p = getProvider(db, providerID)
      if (p) {
        p.LastSyncAt = now
        p.LastSyncError = ''
      }
      return { addedIDs, updated, missing, models: modelsOf(db, providerID).map(toModelDTO) }
    })
    result.Added = synced.addedIDs.length
    result.AddedIDs = synced.addedIDs
    result.Updated = synced.updated
    result.Missing = synced.missing
    result.Models = synced.models
    result.Total = synced.models.length
    result.DurationMs = Date.now() - start
    return result
  },

  ListModels: async (providerId) => modelsOf(loadDb(), providerId.trim()).map(toModelDTO),

  SaveManualModel: async (input) =>
    mutateDb((db) => {
      const providerID = input.ProviderID.trim()
      mustProvider(db, providerID)
      const remoteID = input.RemoteID.trim()
      if (!remoteID) throw new Error('远端模型 ID 不能为空')
      validateTextLen('远端模型 ID', remoteID, MAX_REMOTE_ID_LEN)
      const displayName = input.DisplayName.trim() || remoteID
      validateTextLen('模型名称', displayName, MAX_TITLE_LEN)
      const modality = input.Modality.trim() || heuristicModality(remoteID)
      validateEnum('模型类型', modality, MODALITIES)

      const now = nowMs()
      let model: StoredModel
      if (!input.ID.trim()) {
        model = {
          ID: newId(),
          ProviderID: providerID,
          RemoteID: '',
          DisplayName: '',
          Modality: '',
          CapabilitiesJSON: '{}',
          Source: 'manual',
          Enabled: true,
          MissingRemote: false,
          LastSeenAt: now,
        }
        db.models.push(model)
      } else {
        model = mustModel(db, input.ID.trim())
      }
      // 对齐 UNIQUE(provider_id, remote_id)。
      const duplicate = db.models.find(
        (m) => m.ProviderID === providerID && m.RemoteID === remoteID && m.ID !== model.ID,
      )
      if (duplicate) throw new Error('保存模型失败：该远端模型 ID 已存在')
      model.RemoteID = remoteID
      model.DisplayName = displayName
      model.Modality = modality
      return toModelDTO(model)
    }),

  SetModelEnabled: async (id, enabled) => {
    mutateDb((db) => {
      const model = db.models.find((m) => m.ID === id.trim())
      if (!model) throw new Error('模型不存在')
      model.Enabled = enabled
    })
  },

  DeleteModel: async (id) => {
    mutateDb((db) => {
      const modelID = id.trim()
      clearAssistantReferences(db, modelID, false)
      const index = db.models.findIndex((m) => m.ID === modelID)
      if (index < 0) throw new Error('模型不存在')
      db.models.splice(index, 1)
    })
  },

  PurgeMissingModels: async (providerId) =>
    mutateDb((db) => {
      const id = providerId.trim()
      let purged = 0
      for (const m of db.models.filter((m) => m.ProviderID === id)) {
        if (!m.MissingRemote || m.Source !== 'synced') continue
        clearAssistantReferences(db, m.ID, false)
        db.models = db.models.filter((x) => x.ID !== m.ID)
        purged += 1
      }
      return purged
    }),

  CopyProviderAPIKey: async (id) => {
    const provider = mustProvider(loadDb(), id.trim())
    const key = getProviderKey(provider.ID)
    if (!key.trim()) throw new Error('该服务未配置 API Key')
    await copyToSystemClipboard(key)
  },

  ListAssistants: async () => assistantsOf(loadDb()).map(toAssistantDTO),

  SaveAssistant: async (input) =>
    mutateDb((db) => {
      const name = input.Name.trim() || '新助手'
      validateTextLen('助手名称', name, MAX_NAME_LEN)
      const emoji = input.Emoji.trim() || DEFAULT_ASSISTANT_EMOJI
      // 头像字段除 emoji 外还接受 'icon:<名>:<色>' 规格，上限放宽到 64。
      validateTextLen('助手 Emoji', emoji, 64)
      validateTextLen('系统提示词', input.SystemPrompt, MAX_PROMPT_LEN)
      if (input.TemperatureSet && (input.Temperature < 0 || input.Temperature > 2)) {
        throw new Error('温度必须在 0 到 2 之间')
      }
      const providerID = input.ProviderID.trim()
      if (providerID) mustProvider(db, providerID)
      const modelID = input.ModelID.trim()
      if (modelID) mustModel(db, modelID)

      const now = nowMs()
      let assistant: StoredAssistant
      if (!input.ID.trim()) {
        assistant = {
          ID: newId(),
          Name: '',
          Emoji: '',
          SystemPrompt: '',
          ProviderID: '',
          ModelID: '',
          Temperature: 0,
          TemperatureSet: false,
          WebSearchDefault: false,
          SortOrder: db.assistants.length,
          CreatedAt: now,
          UpdatedAt: now,
        }
        db.assistants.push(assistant)
      } else {
        assistant = mustAssistant(db, input.ID.trim())
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
      return toAssistantDTO(assistant)
    }),

  DeleteAssistant: async (id) => {
    mutateDb((db) => {
      const assistantID = id.trim()
      const index = db.assistants.findIndex((a) => a.ID === assistantID)
      if (index < 0) throw new Error('助手不存在')
      db.assistants.splice(index, 1)
      // 对齐 ON DELETE CASCADE：话题/目录随助手删，消息随话题删。
      const topicIDs = new Set(db.topics.filter((t) => t.AssistantID === assistantID).map((t) => t.ID))
      db.topics = db.topics.filter((t) => t.AssistantID !== assistantID)
      db.folders = db.folders.filter((f) => f.AssistantID !== assistantID)
      db.messages = db.messages.filter((m) => !topicIDs.has(m.TopicID))
      restoreAssistantInvariant(db, assistantID)
    })
  },

  ListTopics: async (assistantId) =>
    mutateDb((db) => {
      mustAssistant(db, assistantId.trim())
      // 进入助手时若无会话自动补一个默认话题（幂等）。
      return ensureTopics(db, assistantId.trim())
    }),

  CreateTopic: async (input) =>
    mutateDb((db) => {
      mustAssistant(db, input.AssistantID.trim())
      const title = input.Title.trim() || DEFAULT_TOPIC_TITLE
      validateTextLen('话题标题', title, MAX_TITLE_LEN)
      const topic = createTopic(db, input.AssistantID.trim(), title)
      return toTopicDTO(topic, 0, false)
    }),

  RenameTopic: async (id, title) => {
    mutateDb((db) => {
      const value = title.trim()
      if (!value) throw new Error('话题标题不能为空')
      validateTextLen('话题标题', value, MAX_TITLE_LEN)
      const topic = mustTopic(db, id.trim())
      topic.Title = value
      topic.UpdatedAt = nowMs()
    })
  },

  DeleteTopic: async (id) => {
    mutateDb((db) => {
      const topicID = id.trim()
      const index = db.topics.findIndex((t) => t.ID === topicID)
      if (index < 0) throw new Error('话题不存在')
      db.topics.splice(index, 1)
      db.messages = db.messages.filter((m) => m.TopicID !== topicID)
    })
  },

  DuplicateTopic: async (topicId) =>
    mutateDb((db) => {
      const source = mustTopic(db, topicId.trim())
      const path = activePath(source, messagesOf(db, source.ID))
      const now = nowMs()
      const topic: StoredTopic = {
        ID: newId(),
        AssistantID: source.AssistantID,
        Title: duplicateTitle(source.Title),
        ActiveNodeID: '',
        FolderID: '',
        Favorite: false,
        SortOrder: 0,
        CreatedAt: now,
        UpdatedAt: now,
      }
      db.topics.push(topic)
      // 只复制活动路径；生成中状态改 cancelled，副本不会留下永远进行中的占位。
      let lastID = ''
      path.forEach((item, index) => {
        const message: StoredMessage = {
          ID: newId(),
          TopicID: topic.ID,
          ParentID: lastID,
          Role: item.Role,
          Status: item.Status === 'pending' || item.Status === 'streaming' ? 'cancelled' : item.Status,
          PartsJSON: item.PartsJSON,
          ProviderID: item.ProviderID,
          ModelRemoteID: item.ModelRemoteID,
          SortOrder: index + 1,
          CreatedAt: now,
          UpdatedAt: now,
        }
        db.messages.push(message)
        lastID = message.ID
      })
      if (lastID) topic.ActiveNodeID = lastID
      return toTopicDTO(topic, path.length, false)
    }),

  ExportTopicMarkdown: async (topicId) => exportTopicMarkdownImpl(loadDb(), topicId),

  SaveTopicMarkdown: async (topicId, fileName) => {
    // 正文始终由后端层重新渲染；浏览器没有保存对话框，用下载代替。
    const exportData = exportTopicMarkdownImpl(loadDb(), topicId)
    let name = sanitizeExportName(fileName)
    if (!name) name = exportData.FileName
    if (!name.toLowerCase().endsWith('.md')) name += '.md'
    const blob = new Blob([exportData.Markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return { Saved: true, FileName: name }
  },

  ListTopicFolders: async (assistantId) => {
    const db = loadDb()
    mustAssistant(db, assistantId.trim())
    return foldersOf(db, assistantId.trim()).map(toTopicFolderDTO)
  },

  SaveTopicFolder: async (input) =>
    mutateDb((db) => {
      const name = input.Name.trim()
      if (!name) throw new Error('目录名称不能为空')
      validateTextLen('目录名称', name, MAX_NAME_LEN)
      const now = nowMs()
      // ID 非空 = 仅改名，parent/zone/sort_order 不动。
      if (input.ID.trim()) {
        const folder = mustFolder(db, input.ID.trim())
        folder.Name = name
        folder.UpdatedAt = now
        return toTopicFolderDTO(folder)
      }
      const assistantID = input.AssistantID.trim()
      mustAssistant(db, assistantID)
      const zone = input.Zone.trim()
      validateEnum('目录区域', zone, TOPIC_FOLDER_ZONES)
      const parentID = input.ParentID.trim()
      const folder: StoredTopicFolder = {
        ID: newId(),
        AssistantID: assistantID,
        ParentID: parentID,
        Name: name,
        Zone: zone,
        SortOrder: 0,
        CreatedAt: now,
        UpdatedAt: now,
      }
      if (parentID) validateFolderParent(db, assistantID, parentID, zone, folder.ID)
      // 新建目录排在同父容器末尾。
      folder.SortOrder = folderChildren(db, assistantID, parentID, zone).length
      db.folders.push(folder)
      return toTopicFolderDTO(folder)
    }),

  DeleteTopicFolder: async (id) => {
    mutateDb((db) => {
      const folder = mustFolder(db, id.trim())
      // 子目录提升一级，排序下标保持原值。
      for (const child of folderChildren(db, folder.AssistantID, folder.ID, folder.Zone)) {
        child.ParentID = folder.ParentID
      }
      // 目录下话题提升一级，收藏标记保持不变。
      const now = nowMs()
      for (const topic of db.topics) {
        if (topic.AssistantID === folder.AssistantID && topic.FolderID === folder.ID) {
          topic.FolderID = folder.ParentID
          topic.UpdatedAt = now
        }
      }
      db.folders = db.folders.filter((f) => f.ID !== folder.ID)
    })
  },

  MoveTopic: async (input) => {
    mutateDb((db) => {
      const topic = mustTopic(db, input.TopicID.trim())
      const folderID = input.FolderID.trim()
      if (folderID) {
        const folder = mustFolder(db, folderID)
        if (folder.AssistantID !== topic.AssistantID) throw new Error('目录不属于该助手')
        // 收藏话题只能进收藏区目录，普通话题只能进普通区目录。
        if (input.Favorite && folder.Zone !== 'fav') throw new Error('目录与目标区域不一致')
        if (!input.Favorite && folder.Zone !== '') throw new Error('目录与目标区域不一致')
      }
      topic.FolderID = folderID
      topic.Favorite = input.Favorite
      topic.UpdatedAt = nowMs()
      const siblings = topicSiblings(db, topic.AssistantID, folderID, input.Favorite)
      // 目标容器内把本话题插到指定下标，再重写 0..n-1（SetSortOrder 不动 updated_at）。
      reorderById(siblings, topic.ID, input.SortOrder).forEach((item, index) => {
        item.SortOrder = index
      })
    })
  },

  MoveTopicFolder: async (input) => {
    mutateDb((db) => {
      const folder = mustFolder(db, input.FolderID.trim())
      const zone = input.Zone.trim()
      validateEnum('目录区域', zone, TOPIC_FOLDER_ZONES)
      const parentID = input.ParentID.trim()
      if (parentID) validateFolderParent(db, folder.AssistantID, parentID, zone, folder.ID)
      folder.ParentID = parentID
      folder.Zone = zone
      folder.SortOrder = input.SortOrder
      const siblings = folderChildren(db, folder.AssistantID, parentID, zone)
      // 目标容器内把本目录插到指定下标，再重写 0..n-1（对齐 SetParentAndOrder）。
      reorderById(siblings, folder.ID, input.SortOrder).forEach((item, index) => {
        item.ParentID = parentID
        item.Zone = zone
        item.SortOrder = index
      })
    })
  },

  // beforeOrder/limit 是契约保留的分页参数：树模型下始终返回完整活动分支。
  ListMessages: async (topicId, _beforeOrder, _limit) => {
    const { all, path } = loadTopicPath(loadDb(), topicId.trim())
    return pathMessageDTOs(path, all)
  },

  StartTurn: async (input) =>
    mutateDb((db) => {
      const { topic, all, path } = loadTopicPath(db, input.TopicID.trim())
      const userText = input.UserText
      if (!userText.trim()) throw new Error('消息内容不能为空')
      validateTextLen('消息内容', userText, MAX_MESSAGE_LEN)
      const target = resolveTurnTarget(db, input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)

      // 新消息挂在活动分支末端：空话题从根开始，否则成为活动节点的子节点。
      const parentID = path.length ? path[path.length - 1].ID : ''
      const history = pathMessageDTOs(path, all)
      const order = nextSortOrder(all)
      const now = nowMs()
      const userMessage: StoredMessage = {
        ID: newId(),
        TopicID: topic.ID,
        ParentID: parentID,
        Role: 'user',
        Status: 'done',
        PartsJSON: textPartsJSON(userText),
        ProviderID: target.providerID,
        ModelRemoteID: target.remoteID,
        SortOrder: order,
        CreatedAt: now,
        UpdatedAt: now,
      }
      const assistantMessage: StoredMessage = {
        ID: newId(),
        TopicID: topic.ID,
        ParentID: userMessage.ID,
        Role: 'assistant',
        Status: 'streaming',
        PartsJSON: '[]',
        ProviderID: target.providerID,
        ModelRemoteID: target.remoteID,
        SortOrder: order + 1,
        CreatedAt: now,
        UpdatedAt: now,
      }
      db.messages.push(userMessage, assistantMessage)
      topic.ActiveNodeID = assistantMessage.ID
      if (!topic.Title.trim() || topic.Title === DEFAULT_TOPIC_TITLE) {
        const title = autoTitle(userText)
        if (title) topic.Title = title
      }
      topic.UpdatedAt = now
      const combined = [...all, userMessage, assistantMessage]
      return {
        Topic: toTopicDTO(topic, combined.length, branchesIn(combined)),
        UserMessage: siblingMessageDTO(combined, userMessage),
        AssistantMessage: siblingMessageDTO(combined, assistantMessage),
        Assistant: toAssistantDTO(assistantOf(db, topic)),
        Model: toModelDTO(target.model),
        Provider: toProviderDTO(db, target.provider),
        History: history,
      }
    }),

  StartAssistantMessage: async (input) =>
    mutateDb((db) => {
      const target = resolveTurnTarget(db, input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)
      const { topic, all } = loadTopicPath(db, input.TopicID.trim())
      const parent = findMessage(all, input.ParentMessageID.trim())
      if (!parent || parent.Role !== 'user') throw new Error('只能对用户消息生成回复')
      // 上下文是该用户消息所在分支，且去掉这条用户消息本身。
      const branch = pathTo(all, parent.ID).slice(0, -1)
      const history = pathMessageDTOs(branch, all)

      const order = nextSortOrder(all)
      const now = nowMs()
      const message: StoredMessage = {
        ID: newId(),
        TopicID: topic.ID,
        ParentID: parent.ID,
        Role: 'assistant',
        Status: 'streaming',
        PartsJSON: '[]',
        ProviderID: target.providerID,
        ModelRemoteID: target.remoteID,
        SortOrder: order,
        CreatedAt: now,
        UpdatedAt: now,
      }
      db.messages.push(message)
      topic.ActiveNodeID = message.ID
      topic.UpdatedAt = now
      const combined = [...all, message]
      return {
        Topic: toTopicDTO(topic, combined.length, branchesIn(combined)),
        UserMessage: siblingMessageDTO(combined, parent),
        AssistantMessage: siblingMessageDTO(combined, message),
        Assistant: toAssistantDTO(assistantOf(db, topic)),
        Model: toModelDTO(target.model),
        Provider: toProviderDTO(db, target.provider),
        History: history,
      }
    }),

  EditAndResendUserMessage: async (input) =>
    mutateDb((db) => {
      const text = input.Text
      if (!text.trim()) throw new Error('消息内容不能为空')
      validateTextLen('消息内容', text, MAX_MESSAGE_LEN)
      const target = resolveTurnTarget(db, input.ProviderID, input.ModelID, input.ModelRemoteID, input.ModelModality)
      const original = getMessage(db, input.MessageID.trim())
      if (!original) throw new Error('消息不存在')
      const { topic, all, path } = loadTopicPath(db, original.TopicID)
      // 只允许编辑用户消息，且必须落在当前活动分支上。
      if (original.Role !== 'user' || !path.some((m) => m.ID === original.ID)) {
        throw new Error('只能编辑当前分支上的消息')
      }
      // 新变体的上下文是原消息父节点的分支（不含原消息本身）。
      const history = pathMessageDTOs(pathTo(all, original.ParentID), all)

      const order = nextSortOrder(all)
      const now = nowMs()
      const userMessage: StoredMessage = {
        ID: newId(),
        TopicID: topic.ID,
        ParentID: original.ParentID,
        Role: 'user',
        Status: 'done',
        PartsJSON: textPartsJSON(text),
        ProviderID: target.providerID,
        ModelRemoteID: target.remoteID,
        SortOrder: order,
        CreatedAt: now,
        UpdatedAt: now,
      }
      const assistantMessage: StoredMessage = {
        ID: newId(),
        TopicID: topic.ID,
        ParentID: userMessage.ID,
        Role: 'assistant',
        Status: 'streaming',
        PartsJSON: '[]',
        ProviderID: target.providerID,
        ModelRemoteID: target.remoteID,
        SortOrder: order + 1,
        CreatedAt: now,
        UpdatedAt: now,
      }
      db.messages.push(userMessage, assistantMessage)
      topic.ActiveNodeID = assistantMessage.ID
      topic.UpdatedAt = now
      const combined = [...all, userMessage, assistantMessage]
      return {
        Topic: toTopicDTO(topic, combined.length, branchesIn(combined)),
        UserMessage: siblingMessageDTO(combined, userMessage),
        AssistantMessage: siblingMessageDTO(combined, assistantMessage),
        Assistant: toAssistantDTO(assistantOf(db, topic)),
        Model: toModelDTO(target.model),
        Provider: toProviderDTO(db, target.provider),
        History: history,
      }
    }),

  SaveTurnSnapshot: async (input) => {
    mutateDb((db) => {
      validatePartsJSON('消息片段', input.PartsJSON)
      const status = input.Status.trim() || 'streaming'
      validateEnum('消息状态', status, MESSAGE_STATUS)
      const message = db.messages.find((m) => m.ID === input.MessageID.trim())
      // ignoreMissing：流式过程中消息可能已被删除，按幂等成功处理。
      if (!message) return
      message.PartsJSON = input.PartsJSON
      message.Status = status
      message.UpdatedAt = nowMs()
    })
  },

  FinishTurn: async (input) => {
    mutateDb((db) => {
      const status = input.Status.trim() || 'done'
      validateEnum('消息状态', status, FINAL_STATUS)
      validatePartsJSON('消息片段', input.PartsJSON)
      const message = db.messages.find((m) => m.ID === input.MessageID.trim())
      if (!message) return
      message.PartsJSON = input.PartsJSON
      message.Status = status
      message.UpdatedAt = nowMs()
      // ErrorCode/ErrorMessage 与 Go 侧一致：错误文案由调用方拼进 parts，不落独立字段。
    })
  },

  DeleteMessage: async (id) => {
    deleteMessagesImpl([id])
  },

  DeleteMessages: async (ids) => deleteMessagesImpl(ids),

  SetActiveNode: async (topicId, messageId) => {
    mutateDb((db) => {
      const message = getMessage(db, messageId.trim())
      if (!message) throw new Error('消息不存在')
      if (message.TopicID !== topicId.trim()) throw new Error('消息不属于该话题')
      const topic = mustTopic(db, topicId.trim())
      topic.ActiveNodeID = message.ID
      topic.UpdatedAt = nowMs()
    })
  },

  SwitchToBranch: async (topicId, messageId) => {
    mutateDb((db) => {
      const message = getMessage(db, messageId.trim())
      if (!message) throw new Error('消息不存在')
      if (message.TopicID !== topicId.trim()) throw new Error('消息不属于该话题')
      const topic = mustTopic(db, topicId.trim())
      const all = messagesOf(db, topic.ID)
      // 每个父节点只保留 sort_order 最大的子节点，一路下探到叶子。
      const next = new Map<string, StoredMessage>()
      for (const m of all) {
        if (!m.ParentID) continue
        const current = next.get(m.ParentID)
        if (!current || m.SortOrder > current.SortOrder) next.set(m.ParentID, m)
      }
      let leaf = message.ID
      for (let i = 0; i < all.length; i += 1) {
        const child = next.get(leaf)
        if (!child) break
        leaf = child.ID
      }
      topic.ActiveNodeID = leaf
      topic.UpdatedAt = nowMs()
    })
  },

  GetTopicTree: async (topicId) => {
    const db = loadDb()
    const { topic, all } = loadTopicPath(db, topicId.trim())
    const byID = new Map(all.map((m) => [m.ID, m]))
    const children = new Map<string, StoredMessage[]>()
    const roots: StoredMessage[] = []
    for (const m of all) {
      // 根节点 = ParentID 为空或父节点不在集合中（异常数据也保证进树）。
      if (!m.ParentID || !byID.has(m.ParentID)) roots.push(m)
      else {
        const list = children.get(m.ParentID)
        if (list) list.push(m)
        else children.set(m.ParentID, [m])
      }
    }
    // 全部消息的兄弟序号一次算好。
    const stats = new Map<string, { index: number; count: number }>()
    for (const dto of pathMessageDTOs(all, all)) {
      stats.set(dto.ID, { index: dto.SiblingIndex, count: dto.SiblingCount })
    }
    const onPath = new Set(pathTo(all, topic.ActiveNodeID).map((m) => m.ID))
    const nodes: TreeNodeDTO[] = []
    const visited = new Set<string>()
    const walk = (m: StoredMessage): void => {
      if (visited.has(m.ID)) return
      visited.add(m.ID)
      const kids = children.get(m.ID) ?? []
      const stat = stats.get(m.ID) ?? { index: 1, count: 1 }
      nodes.push({
        ID: m.ID,
        ParentID: m.ParentID,
        Role: m.Role,
        Status: m.Status,
        Preview: previewFromParts(m.PartsJSON),
        SiblingIndex: stat.index,
        SiblingCount: stat.count,
        ChildCount: kids.length,
        OnActivePath: onPath.has(m.ID),
        IsActive: m.ID === topic.ActiveNodeID,
        CreatedAt: m.CreatedAt,
      })
      for (const kid of kids) walk(kid)
    }
    for (const root of roots) walk(root)
    return { TopicID: topic.ID, ActiveNodeID: topic.ActiveNodeID, Nodes: nodes }
  },

  SaveAppSettings: async (input) =>
    mutateDb((db) => {
      const theme = input.Theme.trim() || 'system'
      validateEnum('主题', theme, THEMES)
      const assistantID = input.ActiveAssistantID.trim()
      if (assistantID) mustAssistant(db, assistantID)
      const topicID = input.ActiveTopicID.trim()
      if (topicID) mustTopic(db, topicID)
      const settings: AppSettingsDTO = {
        ActiveAssistantID: assistantID,
        ActiveTopicID: topicID,
        Theme: theme,
      }
      saveAppSettings(db, settings)
      return settings
    }),

  GetSearchSettings: async () => getSearchSettings(loadDb()),

  SaveSearchSettings: async (input) =>
    mutateDb((db) => {
      const serviceID = input.ServiceID.trim() || DEFAULT_SEARCH_SERVICE
      validateEnum('搜索服务类型', serviceID, SEARCH_SERVICES)
      let baseURL = input.BaseURL.trim()
      if (baseURL) baseURL = normalizeBaseURL(baseURL)
      else if (input.Enabled) throw new Error('启用联网搜索前请填写搜索服务地址')
      let maxResults = input.MaxResults
      if (maxResults <= 0) maxResults = DEFAULT_MAX_RESULTS
      if (maxResults > MAX_SEARCH_RESULTS) throw new Error(`最大结果数不能超过 ${MAX_SEARCH_RESULTS}`)
      if (input.ClearAPIKey) setSearchKey('')
      else if (input.APIKey.trim()) setSearchKey(input.APIKey)
      db.settings[SETTING_KEY_SEARCH] = JSON.stringify({
        Enabled: input.Enabled,
        ServiceID: serviceID,
        BaseURL: baseURL,
        MaxResults: maxResults,
      })
      return getSearchSettings(db)
    }),

  CopySearchAPIKey: async () => {
    const key = getSearchKey()
    if (!key.trim()) throw new Error('尚未配置搜索服务 API Key')
    await copyToSystemClipboard(key)
  },

  Search: async (input) => {
    const query = input.Query.trim()
    if (!query) throw new Error('搜索关键词不能为空')
    validateTextLen('搜索关键词', query, MAX_QUERY_LEN)
    const settings = getSearchSettings(loadDb())
    if (!settings.Enabled) throw new Error('联网搜索未启用')
    if (!settings.BaseURL.trim()) throw new Error('请先配置搜索服务地址')
    let limit = input.Limit
    if (limit <= 0) limit = settings.MaxResults
    if (limit <= 0) limit = DEFAULT_MAX_RESULTS
    if (limit > MAX_SEARCH_RESULTS) limit = MAX_SEARCH_RESULTS
    const start = Date.now()

    let endpoint: URL
    try {
      endpoint = new URL(resolveEndpoint(settings.BaseURL, '/search'))
    } catch (err) {
      throw new Error(`搜索失败：${trimErrText(errText(err))}`)
    }
    endpoint.searchParams.set('q', query)
    endpoint.searchParams.set('format', 'json')
    endpoint.searchParams.set('language', 'zh-CN')
    const apiKey = getSearchKey()
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`

    let resp: Response
    try {
      resp = await fetchWithTimeout(endpoint.toString(), { headers }, 15_000)
    } catch (err) {
      throw new Error(`搜索失败：${trimErrText(fetchErrorText(err))}`)
    }
    if (!resp.ok) throw new Error(`搜索失败：搜索服务返回状态码 ${resp.status}`)
    const body = await resp.text().catch(() => '')
    if (byteLen(body) > MAX_SEARCH_BYTES) throw new Error('搜索失败：搜索响应内容过大')
    interface SearxngItem {
      title?: string
      url?: string
      content?: string
      engine?: string
    }
    let parsed: { results?: SearxngItem[] }
    try {
      const raw = JSON.parse(body) as unknown
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('bad')
      parsed = raw as { results?: SearxngItem[] }
    } catch {
      throw new Error('搜索失败：搜索服务返回的数据无法解析')
    }
    const results: SearchResultDTO[] = []
    for (const item of parsed.results ?? []) {
      if (results.length >= limit) break
      let link: string
      try {
        link = validateExternalURL((item?.url ?? '').trim())
      } catch {
        continue // 只保留 http/https 结果
      }
      const title = (item?.title ?? '').trim() || link
      results.push({
        Title: title,
        URL: link,
        Snippet: (item?.content ?? '').trim(),
        Engine: (item?.engine ?? '').trim(),
      })
    }
    return { Results: results, ElapsedMs: Date.now() - start }
  },

  // web 模式走 webFetch 直连，不会调用这两个方法；保留签名仅作兜底。
  StartProviderRequest: async (input) => ({ RequestID: input.RequestID }),
  CancelProviderRequest: async () => {},

  // 浏览器无本地中转与系统代理控制：中转恒关，代理设置仅存不生效。
  GetRelayStatus: async () => ({ ...RELAY_DISABLED }),
  SetRelayEnabled: async () => ({ ...RELAY_DISABLED }),

  GetProxySettings: async () => {
    const raw = loadDb().settings[SETTING_KEY_PROXY]
    if (!raw || !raw.trim()) return { URL: '', VerifySSL: false }
    let stored: { URL?: string }
    try {
      stored = JSON.parse(raw) as { URL?: string }
    } catch {
      throw new Error('代理设置格式错误')
    }
    return { URL: normalizeProxyURL(stored.URL ?? ''), VerifySSL: false }
  },

  SaveProxySettings: async (input) => {
    const normalized = normalizeProxyURL(input.URL)
    mutateDb((db) => {
      db.settings[SETTING_KEY_PROXY] = JSON.stringify({ URL: normalized })
    })
    return { URL: normalized, VerifySSL: false }
  },

  LoadRemoteImage: async (messageId, imageURL) => {
    const message = getMessage(loadDb(), messageId.trim())
    if (!message) throw new Error('消息不存在')
    let parts: Array<{ type?: string; url?: string }>
    try {
      const parsed = JSON.parse(message.PartsJSON) as unknown
      if (!Array.isArray(parsed)) throw new Error('bad')
      parts = parsed as Array<{ type?: string; url?: string }>
    } catch {
      throw new Error('消息图片数据无效')
    }
    const found = parts.some((part) => part?.type === 'image' && part?.url === imageURL && imageURL !== '')
    if (!found) throw new Error('图片地址不属于此消息')
    if (imageURL.length > 16 << 10) throw new Error('图片地址过长')
    let u: URL
    try {
      u = new URL(imageURL)
    } catch {
      throw new Error('图片地址无效')
    }
    if (
      !u.hostname ||
      u.username ||
      u.password ||
      u.hash ||
      (u.protocol !== 'http:' && u.protocol !== 'https:')
    ) {
      throw new Error('图片地址无效')
    }
    let resp: Response
    try {
      resp = await fetchWithTimeout(u.toString(), { headers: { accept: 'image/*' } }, 60_000)
    } catch (err) {
      throw new Error(trimErrText(fetchErrorText(err)))
    }
    if (!resp.ok) throw new Error(`图片加载失败（HTTP ${resp.status}）`)
    const buffer = await resp.arrayBuffer().catch(() => null)
    if (!buffer) throw new Error('图片加载失败')
    if (buffer.byteLength > MAX_INTERNAL_BYTES) throw new Error('响应内容过大')
    const bytes = new Uint8Array(buffer)
    // 不信任远端 Content-Type，按字节嗅探；HTML/SVG 一律拒绝。
    const mime = sniffImageMime(bytes)
    if (!mime) throw new Error('远程响应不是支持的图片格式')
    return `data:${mime};base64,${bytesToBase64(bytes)}`
  },

  OpenExternalURL: async (url) => {
    const safe = validateExternalURL(url)
    window.open(safe, '_blank', 'noopener')
  },
}

/** 副本标题：原标题为空退回默认；超长先截断再拼后缀（对齐 duplicateTopicTitle）。 */
function duplicateTitle(title: string): string {
  const base = title.trim() || DEFAULT_TOPIC_TITLE
  const limit = MAX_TITLE_LEN - runes(DUPLICATE_TITLE_SUFFIX).length
  const chars = runes(base)
  const truncated = limit > 0 && chars.length > limit ? chars.slice(0, limit).join('') : base
  return truncated + DUPLICATE_TITLE_SUFFIX
}
