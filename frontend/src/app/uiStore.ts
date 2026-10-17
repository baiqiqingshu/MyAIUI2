import { create } from 'zustand'
import { appApi } from '../bridge/appApi'
import type {
  AppSettingsDTO,
  AssistantDTO,
  BootstrapDTO,
  ModelDTO,
  ProviderDTO,
  SearchSettingsDTO,
  TopicDTO,
  TopicFolderDTO,
} from '../domain/dto'

export type ToastKind = 'info' | 'success' | 'error'
export interface ToastItem {
  id: string
  kind: ToastKind
  text: string
}

/** 主区视图：chat = 话题栏 + 对话工作区，models = 模型服务整页。 */
export type MainView = 'chat' | 'models'

export type DrawerState =
  | { kind: 'none' }
  | { kind: 'assistant'; assistantId: string } // 空字符串 = 新建助手

const EMPTY_SETTINGS: AppSettingsDTO = { ActiveAssistantID: '', ActiveTopicID: '', Theme: 'system' }
const EMPTY_SEARCH: SearchSettingsDTO = {
  Enabled: false,
  ServiceID: 'searxng',
  BaseURL: '',
  HasAPIKey: false,
  MaxResults: 5,
}

/**
 * 可用于对话与助手绑定的模型：模型自身启用，且其模型服务存在且已启用。
 * 停用服务商后，其模型必须立刻从对话页与助手设置的模型选择里消失——这是唯一判定入口，
 * 不要再在组件里各写一遍 `m.Enabled` 过滤（曾因此在对话页漏掉服务商开关）。
 */
export function selectUsableModels(models: ModelDTO[], providers: ProviderDTO[]): ModelDTO[] {
  return models.filter(
    (model) => model.Enabled && providers.some((p) => p.ID === model.ProviderID && p.Enabled),
  )
}

interface UiState {
  ready: boolean
  fatalError: string
  appName: string
  version: string
  settings: AppSettingsDTO
  search: SearchSettingsDTO
  assistants: AssistantDTO[]
  providers: ProviderDTO[]
  models: ModelDTO[]
  topics: TopicDTO[]
  /** 当前助手的话题目录（普通区 + 收藏区），随 loadTopics 一起刷新 */
  folders: TopicFolderDTO[]
  activeAssistantId: string
  activeTopicId: string
  mainView: MainView
  drawer: DrawerState
  toasts: ToastItem[]

  showToast: (text: string, kind?: ToastKind) => void
  dismissToast: (id: string) => void
  openDrawer: (drawer: DrawerState) => void
  closeDrawer: () => void

  applyBootstrap: (data: BootstrapDTO) => void
  setFatalError: (message: string) => void
  setSearchSettings: (settings: SearchSettingsDTO) => void

  selectAssistant: (assistantId: string) => void
  selectTopic: (topicId: string) => void
  setMainView: (view: MainView) => void
  refreshAssistants: (preferId?: string) => Promise<void>
  refreshTopics: (assistantId?: string) => Promise<void>
  /** 拉取话题目录；assistantId 缺省为当前助手 */
  refreshFolders: (assistantId?: string) => Promise<void>
  refreshProviders: () => Promise<void>
  refreshModels: () => Promise<void>

  activeAssistant: () => AssistantDTO | undefined
  activeTopic: () => TopicDTO | undefined
  providersOfActiveAssistant: () => ProviderDTO[]
  modelsOfProvider: (providerId: string) => ModelDTO[]
  findModel: (modelId: string) => ModelDTO | undefined
  findProvider: (providerId: string) => ProviderDTO | undefined
}

let toastSeq = 0

export const useUiStore = create<UiState>()((set, get) => {
  function persistSettings(patch: Partial<AppSettingsDTO>) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    appApi.SaveAppSettings(next).catch(() => {
      /* 设置持久化失败不阻塞交互 */
    })
  }

  async function loadFolders(assistantId: string) {
    if (!assistantId) {
      set({ folders: [] })
      return
    }
    set({ folders: await appApi.ListTopicFolders(assistantId) })
  }

  async function loadTopics(assistantId: string) {
    if (!assistantId) {
      set({ topics: [], folders: [], activeTopicId: '' })
      return
    }
    // 目录与话题一起拉取；目录接口失败不阻塞话题列表（降级为空目录）。
    const foldersPromise = appApi
      .ListTopicFolders(assistantId)
      .catch(() => [] as TopicFolderDTO[])
    const topics = await appApi.ListTopics(assistantId)
    const folders = await foldersPromise
    const current = get().activeTopicId
    const stillThere = topics.some((t) => t.ID === current)
    const next = stillThere ? current : (topics[0]?.ID ?? '')
    set({ topics, folders, activeTopicId: next })
    if (next !== current) persistSettings({ ActiveTopicID: next })
  }

  return {
    ready: false,
    fatalError: '',
    appName: 'MyAIUI2',
    version: '',
    settings: EMPTY_SETTINGS,
    search: EMPTY_SEARCH,
    assistants: [],
    providers: [],
    models: [],
    topics: [],
    folders: [],
    activeAssistantId: '',
    activeTopicId: '',
    mainView: 'chat',
    drawer: { kind: 'none' },
    toasts: [],

    showToast(text, kind = 'info') {
      toastSeq += 1
      const id = `toast-${toastSeq}`
      set({ toasts: [...get().toasts, { id, kind, text }] })
      window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 3200)
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) })
    },

    openDrawer(drawer) {
      set({ drawer })
    },

    closeDrawer() {
      set({ drawer: { kind: 'none' } })
    },

    applyBootstrap(data) {
      const assistants = data.Assistants ?? []
      const preferredAssistant =
        assistants.find((a) => a.ID === data.Settings.ActiveAssistantID)?.ID ??
        assistants[0]?.ID ??
        ''
      const topics = data.Topics ?? []
      const preferredTopic =
        topics.find((t) => t.ID === data.Settings.ActiveTopicID)?.ID ?? topics[0]?.ID ?? ''
      set({
        ready: true,
        fatalError: '',
        appName: data.AppName || 'MyAIUI2',
        version: data.Version,
        settings: data.Settings,
        search: data.Search ?? EMPTY_SEARCH,
        assistants,
        providers: data.Providers ?? [],
        models: data.Models ?? [],
        topics,
        folders: [],
        activeAssistantId: preferredAssistant,
        activeTopicId: preferredTopic,
      })
      // Bootstrap 载荷不含目录：置空后立即异步拉取（失败静默，目录不是启动主链路）。
      void loadFolders(preferredAssistant).catch(() => {
        /* 目录拉取失败不影响启动 */
      })
    },

    setFatalError(message) {
      set({ ready: true, fatalError: message })
    },

    setSearchSettings(search) {
      set({ search })
    },

    selectAssistant(assistantId) {
      set({ activeAssistantId: assistantId, topics: [], folders: [], activeTopicId: '' })
      persistSettings({ ActiveAssistantID: assistantId, ActiveTopicID: '' })
      loadTopics(assistantId).catch((err: unknown) => {
        get().showToast(`加载话题失败：${String(err)}`, 'error')
      })
    },

    selectTopic(topicId) {
      set({ activeTopicId: topicId })
      persistSettings({ ActiveTopicID: topicId })
    },

    setMainView(view) {
      set({ mainView: view })
    },

    async refreshAssistants(preferId) {
      const assistants = await appApi.ListAssistants()
      const wanted = preferId ?? get().activeAssistantId
      const next = assistants.find((a) => a.ID === wanted)?.ID ?? assistants[0]?.ID ?? ''
      set({ assistants, activeAssistantId: next })
      if (next !== wanted) {
        persistSettings({ ActiveAssistantID: next, ActiveTopicID: '' })
      }
      await loadTopics(next)
    },

    async refreshTopics(assistantId) {
      await loadTopics(assistantId ?? get().activeAssistantId)
    },

    async refreshFolders(assistantId) {
      await loadFolders(assistantId ?? get().activeAssistantId)
    },

    async refreshProviders() {
      set({ providers: await appApi.ListProviders() })
    },

    async refreshModels() {
      set({ models: await appApi.ListModels('') })
    },

    activeAssistant() {
      return get().assistants.find((a) => a.ID === get().activeAssistantId)
    },

    activeTopic() {
      return get().topics.find((t) => t.ID === get().activeTopicId)
    },

    providersOfActiveAssistant() {
      return get().providers
    },

    modelsOfProvider(providerId) {
      return get().models.filter((m) => m.ProviderID === providerId)
    },

    findModel(modelId) {
      return get().models.find((m) => m.ID === modelId)
    },

    findProvider(providerId) {
      return get().providers.find((p) => p.ID === providerId)
    },
  }
})
