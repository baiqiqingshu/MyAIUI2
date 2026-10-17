import { create } from 'zustand'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import { messageText, type MessagePart } from '../../domain/message'
import type {
  AssistantDTO,
  MessageDTO,
  ModelDTO,
  ProviderDTO,
  TopicTreeDTO,
  TurnDTO,
} from '../../domain/dto'
import { runChat } from '../../lib/ai/chatEngine'
import { runImageGeneration } from '../../lib/ai/imageEngine'

/* 对话状态：每个话题一个会话（SessionState）。切换话题/助手只改 activeTopicId，
   不取消任何进行中的生成；切回时该话题的流式进度与最新消息原样可见。
   持久化一律走 AppAPI；不写 localStorage。 */

const HISTORY_LIMIT = 50
const SNAPSHOT_INTERVAL_MS = 1000

/** 流式中的助手消息：parts 为引擎实时增量。 */
export interface StreamState {
  messageId: string
  parts: MessagePart[]
}

/** 单个话题的会话：消息、消息树、加载与生成状态都按话题隔离。 */
export interface SessionState {
  messages: MessageDTO[]
  tree: TopicTreeDTO | null
  loading: boolean
  generating: boolean
  stream: StreamState | null
}

/** 模块级空会话常量：引用稳定，供选择器在没有会话时兜底（避免每次返回新对象导致重渲染）。 */
export const EMPTY_SESSION: SessionState = {
  messages: [],
  tree: null,
  loading: false,
  generating: false,
  stream: null,
}

/** 兄弟变体导航信息：同一父节点下的多个子节点互为兄弟。 */
export interface SiblingNav {
  count: number
  index: number
  onPrev: () => void
  onNext: () => void
}

interface ChatState {
  /** 当前展示的话题；由 ChatWorkspace 的 effect 与 uiStore.activeTopicId 同步 */
  activeTopicId: string
  /** topicId -> 会话。切走再切回直接复用，进行中的 stream/generating 原样保留 */
  sessions: Record<string, SessionState>
  /** 正在生成的话题 ID 列表（话题树的“生成中”标记等消费） */
  runningTopicIds: string[]
  /** 联网开关：输入区状态，全局单值不随话题；语义＝向模型请求写入联网参数 */
  searchEnabled: boolean

  setTopic: (topicId: string) => void
  setSearchEnabled: (enabled: boolean) => void
  /** 切换助手时把联网开关重置为助手默认值 */
  syncSearchDefault: (enabled: boolean) => void
  send: (text: string) => Promise<boolean>
  stop: () => void
  regenerate: (assistantMessageId: string) => Promise<boolean>
  /** 编辑用户消息并作为兄弟变体重新发送 */
  editAndResend: (messageId: string, text: string) => Promise<boolean>
  /** 切换同一父节点下的相邻版本（方向切换后下探到该变体的最深分支） */
  switchSibling: (messageId: string, direction: 'prev' | 'next') => Promise<void>
  /** 精确回退/前进到某个节点 */
  switchActiveNode: (messageId: string) => Promise<void>
  /** 按当前话题重新加载消息与消息树（切换节点、保存后使用） */
  refresh: () => Promise<void>
  /** 重新拉取消息树（失败静默：树只影响分支 UI） */
  refreshTree: () => Promise<void>
  /** 删除一批消息及其后代子树（后端按子树并集级联），成功后重载消息与树 */
  deleteMessages: (ids: string[]) => Promise<void>
  siblingsFor: (messageId: string) => SiblingNav | null
}

// ---- 每话题的运行/加载通道：保存在 store 外，不进 React 状态 ----
// runIds：同一话题最新一轮的序号；aborts：同一话题当前运行的 AbortController。
// 每话题同时最多一轮（session.generating 守卫），因此只需记录最新值。
const runIds = new Map<string, number>()
const aborts = new Map<string, AbortController>()
// loadSeqs：话题数据的加载序号。本地产生更新状态的写操作（send/regenerate 等）会推进它，
// 使晚到的 ListMessages/GetTopicTree 结果不再覆盖更新的本地状态（例如刚追加的新消息）。
const loadSeqs = new Map<string, number>()
let runSeq = 0

function nextRunId(topicId: string): number {
  runSeq += 1
  runIds.set(topicId, runSeq)
  return runSeq
}

/** 校验同一话题的最新 run：旧 run 的收尾不得覆盖新 run 写入的会话状态。 */
function isCurrentRun(topicId: string, runId: number): boolean {
  return runIds.get(topicId) === runId
}

function nextLoadSeq(topicId: string): number {
  const next = (loadSeqs.get(topicId) ?? 0) + 1
  loadSeqs.set(topicId, next)
  return next
}

function isLatestLoad(topicId: string, seq: number): boolean {
  return loadSeqs.get(topicId) === seq
}

function sessionOf(topicId: string): SessionState {
  if (!topicId) return EMPTY_SESSION
  return useChatStore.getState().sessions[topicId] ?? EMPTY_SESSION
}

/** 写某个话题的会话字段；generating 变化时同步维护 runningTopicIds。 */
function patchSession(topicId: string, patch: Partial<SessionState>): void {
  if (!topicId) return
  useChatStore.setState((prev) => {
    const current = prev.sessions[topicId] ?? EMPTY_SESSION
    const next = { ...current, ...patch }
    let runningTopicIds = prev.runningTopicIds
    if (next.generating !== current.generating) {
      runningTopicIds = next.generating
        ? [...prev.runningTopicIds.filter((id) => id !== topicId), topicId]
        : prev.runningTopicIds.filter((id) => id !== topicId)
    }
    return { sessions: { ...prev.sessions, [topicId]: next }, runningTopicIds }
  })
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/** 占位消息按“已取消”收尾，避免留下永久“生成中”。 */
function finishCancelled(messageId: string): Promise<void> {
  return appApi
    .FinishTurn({
      MessageID: messageId,
      PartsJSON: '[]',
      Status: 'cancelled',
      ErrorCode: '',
      ErrorMessage: '',
    })
    .catch(() => {
      /* 忽略：重启时 MarkStreamingAsInterrupted 会兜底 */
    })
}

/** 节流快照：首次立即写，之后每 ≥1s 写一次（尾部补写），避免逐字打库。 */
function createSnapshotSaver(messageId: string) {
  let lastSavedAt = 0
  let timer: number | null = null
  let latest: MessagePart[] = []

  function write() {
    lastSavedAt = Date.now()
    appApi
      .SaveTurnSnapshot({
        MessageID: messageId,
        PartsJSON: JSON.stringify(latest),
        Status: 'streaming',
      })
      .catch(() => {
        /* 快照失败不打断生成，最终 FinishTurn 仍会落库 */
      })
  }

  return {
    push(parts: MessagePart[]) {
      latest = parts
      const elapsed = Date.now() - lastSavedAt
      if (elapsed >= SNAPSHOT_INTERVAL_MS) {
        write()
        return
      }
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null
          write()
        }, SNAPSHOT_INTERVAL_MS - elapsed)
      }
    },
    dispose() {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    },
  }
}

interface TurnRun {
  topicId: string
  runId: number
  message: MessageDTO
  assistant: AssistantDTO
  provider: ProviderDTO
  model: ModelDTO
  history: MessageDTO[]
  userText: string
  controller: AbortController
}

interface TurnOutcome {
  parts: MessagePart[]
  status: 'done' | 'cancelled' | 'error'
  errorCode: string
  errorMessage: string
}

/** 单轮生成：逐增量写入对应话题会话的 stream + 节流快照，返回最终片段与状态。 */
async function generateOnce(run: TurnRun & { webSearch: boolean }): Promise<TurnOutcome> {
  const { topicId, message, assistant, provider, model, history, userText, webSearch } = run
  const signal = run.controller.signal

  let latest: MessagePart[] = []
  const saver = createSnapshotSaver(message.ID)

  // 不论该话题是否激活都写入它的 session：用户切走再切回时进度连续可见。
  const publish = (parts: MessagePart[]) => {
    latest = parts
    patchSession(topicId, { stream: { messageId: message.ID, parts } })
    saver.push(parts)
  }

  publish([])

  try {
    if (model.Modality === 'image') {
      const part = await runImageGeneration({ provider, model, prompt: userText, signal })
      publish([part])
    } else {
      const parts = await runChat({
        provider,
        model,
        assistant,
        history,
        userText,
        webSearch,
        signal,
        onParts: publish,
      })
      publish(parts)
    }
  } catch (err) {
    if (signal.aborted) {
      saver.dispose()
      return { parts: latest, status: 'cancelled', errorCode: '', errorMessage: '' }
    }
    const raw = describeError(err)
    const code = model.Modality === 'image' ? 'image-failed' : 'chat-failed'
    const errorPart: MessagePart = { type: 'error', code, message: raw }
    publish([...latest, errorPart])
    saver.dispose()
    return { parts: latest, status: 'error', errorCode: code, errorMessage: raw }
  }

  saver.dispose()
  return {
    parts: latest,
    status: signal.aborted ? 'cancelled' : 'done',
    errorCode: '',
    errorMessage: '',
  }
}

/** 执行一轮：生成 → FinishTurn → 更新对应话题会话。由 send/regenerate/editAndResend 触发，不阻塞输入。 */
async function executeTurn(run: TurnRun) {
  const { topicId, runId, message, model, controller } = run
  // 联网开关在发送那一刻取值：webSearch＝向模型请求写入联网参数（图像模型不适用）。
  const webSearch = useChatStore.getState().searchEnabled && model.Modality !== 'image'

  const outcome = await generateOnce({ ...run, webSearch })

  if (aborts.get(topicId) === controller) aborts.delete(topicId)

  try {
    await appApi.FinishTurn({
      MessageID: message.ID,
      PartsJSON: JSON.stringify(outcome.parts),
      Status: outcome.status,
      ErrorCode: outcome.errorCode,
      ErrorMessage: outcome.errorMessage,
    })
  } catch (err) {
    useUiStore.getState().showToast(`保存回复失败：${describeError(err)}`, 'error')
  }

  if (isCurrentRun(topicId, runId)) {
    const partsJSON = JSON.stringify(outcome.parts)
    const session = sessionOf(topicId)
    patchSession(topicId, {
      generating: false,
      stream: null,
      messages: session.messages.map((item) =>
        item.ID === message.ID
          ? { ...item, PartsJSON: partsJSON, Status: outcome.status, UpdatedAt: Date.now() }
          : item,
      ),
    })
    if (outcome.status === 'error') {
      useUiStore.getState().showToast(`生成失败：${outcome.errorMessage}`, 'error')
    }
  }

  // 话题标题/消息数可能已变化（自动命名、计数）
  void useUiStore
    .getState()
    .refreshTopics()
    .catch(() => {
      /* 标题刷新失败不影响对话 */
    })

  // 一轮对话可能产生新分支（重新生成/编辑发送），同步该话题的消息树
  void loadTree(topicId, nextLoadSeq(topicId))
}

/** 发送/重新生成前的目标解析：助手必须绑定到启用服务中的启用模型。 */
function resolveTarget(): { assistant: AssistantDTO; provider: ProviderDTO; model: ModelDTO } | null {
  const ui = useUiStore.getState()
  const assistant = ui.activeAssistant()
  if (!assistant) {
    ui.showToast('还没有可用助手', 'error')
    return null
  }
  const model = assistant.ModelID ? ui.findModel(assistant.ModelID) : undefined
  if (!model || !model.Enabled) {
    ui.showToast('请先选择可用的模型', 'error')
    return null
  }
  const provider = ui.findProvider(model.ProviderID)
  if (!provider) {
    ui.showToast('模型所属的模型服务不存在', 'error')
    return null
  }
  if (!provider.Enabled) {
    ui.showToast('模型服务未启用，请在模型服务中开启', 'error')
    return null
  }
  return { assistant, provider, model }
}

async function loadMessages(topicId: string, seq: number) {
  try {
    const messages = await appApi.ListMessages(topicId, 0, HISTORY_LIMIT)
    if (!isLatestLoad(topicId, seq)) return
    patchSession(topicId, { messages, loading: false })
  } catch (err) {
    if (!isLatestLoad(topicId, seq)) return
    patchSession(topicId, { loading: false })
    useUiStore.getState().showToast(`加载消息失败：${describeError(err)}`, 'error')
  }
}

/** 消息树只服务于分支 UI，取不到时静默降级（不显示兄弟导航）。 */
async function loadTree(topicId: string, seq: number) {
  try {
    const tree = await appApi.GetTopicTree(topicId)
    if (!isLatestLoad(topicId, seq)) return
    patchSession(topicId, { tree })
  } catch {
    /* 静默：分支 UI 不是对话主链路 */
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  activeTopicId: '',
  sessions: {},
  runningTopicIds: [],
  searchEnabled: false,

  setTopic(topicId) {
    if (get().activeTopicId === topicId) return
    // 只切展示目标：不取消任何进行中的生成（run/aborts 均按话题隔离）。
    set({ activeTopicId: topicId })
    if (!topicId || get().sessions[topicId]) return
    patchSession(topicId, { loading: true })
    const seq = nextLoadSeq(topicId)
    void loadMessages(topicId, seq)
    void loadTree(topicId, seq)
  },

  setSearchEnabled(enabled) {
    set({ searchEnabled: enabled })
  },

  syncSearchDefault(enabled) {
    set({ searchEnabled: enabled })
  },

  async send(text) {
    const trimmed = text.trim()
    const topicId = get().activeTopicId
    const session = sessionOf(topicId)
    if (!trimmed || session.generating) return false

    const ui = useUiStore.getState()
    if (!topicId) {
      ui.showToast('请先新建话题', 'error')
      return false
    }
    // 活动路径停在用户消息上（在历史节点回退所致）：直接续写会形成 (user,user) 畸形路径
    const tail = session.messages[session.messages.length - 1]
    if (tail && tail.Role === 'user') {
      ui.showToast('当前停在用户消息上：请用它的「编辑并重新发送」，或在分支面板选择其它节点', 'info')
      return false
    }
    const target = resolveTarget()
    if (!target) return false

    const runId = nextRunId(topicId)
    const controller = new AbortController()
    aborts.set(topicId, controller)
    patchSession(topicId, { generating: true })

    let turn: TurnDTO
    try {
      turn = await appApi.StartTurn({
        TopicID: topicId,
        Title: ui.activeTopic()?.Title ?? '',
        UserText: trimmed,
        ProviderID: target.provider.ID,
        ModelID: target.model.ID,
        ModelRemoteID: target.model.RemoteID,
        ModelModality: target.model.Modality,
      })
    } catch (err) {
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) patchSession(topicId, { generating: false })
      ui.showToast(`发送失败：${describeError(err)}`, 'error')
      return false
    }

    if (controller.signal.aborted) {
      // 等待后端建占位期间被 stop：占位消息直接按取消收尾
      await finishCancelled(turn.AssistantMessage.ID)
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) patchSession(topicId, { generating: false, stream: null })
      return true
    }

    // 消息列表以服务端返回的活动路径为准（History 不含本轮，追加新的一对消息），
    // 同时推进加载序号：使建会话时发出的初始加载结果不再覆盖这里的新状态。
    nextLoadSeq(topicId)
    patchSession(topicId, {
      loading: false,
      messages: [...turn.History, turn.UserMessage, turn.AssistantMessage],
    })
    void useUiStore
      .getState()
      .refreshTopics()
      .catch(() => {
        /* 标题/计数刷新失败可忽略 */
      })

    void executeTurn({
      topicId,
      runId,
      message: turn.AssistantMessage,
      assistant: turn.Assistant,
      provider: turn.Provider,
      model: turn.Model,
      history: turn.History,
      userText: trimmed,
      controller,
    })

    return true
  },

  stop() {
    aborts.get(get().activeTopicId)?.abort()
  },

  async regenerate(assistantMessageId) {
    const topicId = get().activeTopicId
    const session = sessionOf(topicId)
    if (session.generating) return false
    if (!topicId) return false

    // 重新生成 = 给该助手消息的父用户消息再建一个助手子节点，旧回答作为兄弟变体保留
    const source = session.messages.find((m) => m.ID === assistantMessageId)
    const parentMessageId = source?.ParentID ?? ''
    if (!source || !parentMessageId) {
      useUiStore.getState().showToast('无法确定要重新回答的问题', 'error')
      return false
    }

    const target = resolveTarget()
    if (!target) return false

    const runId = nextRunId(topicId)
    const controller = new AbortController()
    aborts.set(topicId, controller)
    patchSession(topicId, { generating: true })

    let turn: TurnDTO
    try {
      turn = await appApi.StartAssistantMessage({
        TopicID: topicId,
        ParentMessageID: parentMessageId,
        ProviderID: target.provider.ID,
        ModelID: target.model.ID,
        ModelRemoteID: target.model.RemoteID,
        ModelModality: target.model.Modality,
      })
    } catch (err) {
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) {
        patchSession(topicId, { generating: false })
        const seq = nextLoadSeq(topicId)
        void loadMessages(topicId, seq)
      }
      useUiStore.getState().showToast(`重新生成失败：${describeError(err)}`, 'error')
      return false
    }

    if (controller.signal.aborted) {
      await finishCancelled(turn.AssistantMessage.ID)
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) patchSession(topicId, { generating: false, stream: null })
      return true
    }

    nextLoadSeq(topicId)
    patchSession(topicId, {
      loading: false,
      messages: [...turn.History, turn.UserMessage, turn.AssistantMessage],
    })

    void executeTurn({
      topicId,
      runId,
      message: turn.AssistantMessage,
      assistant: turn.Assistant,
      provider: turn.Provider,
      model: turn.Model,
      history: turn.History,
      userText: messageText(turn.UserMessage),
      controller,
    })

    return true
  },

  async editAndResend(messageId, text) {
    const trimmed = text.trim()
    const topicId = get().activeTopicId
    const session = sessionOf(topicId)
    if (!trimmed || session.generating) return false
    const ui = useUiStore.getState()
    if (!topicId) {
      ui.showToast('请先新建话题', 'error')
      return false
    }
    const target = resolveTarget()
    if (!target) return false

    const runId = nextRunId(topicId)
    const controller = new AbortController()
    aborts.set(topicId, controller)
    patchSession(topicId, { generating: true })

    let turn: TurnDTO
    try {
      turn = await appApi.EditAndResendUserMessage({
        MessageID: messageId,
        Text: trimmed,
        ProviderID: target.provider.ID,
        ModelID: target.model.ID,
        ModelRemoteID: target.model.RemoteID,
        ModelModality: target.model.Modality,
      })
    } catch (err) {
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) patchSession(topicId, { generating: false })
      ui.showToast(`编辑发送失败：${describeError(err)}`, 'error')
      return false
    }

    if (controller.signal.aborted) {
      await finishCancelled(turn.AssistantMessage.ID)
      if (aborts.get(topicId) === controller) aborts.delete(topicId)
      if (isCurrentRun(topicId, runId)) patchSession(topicId, { generating: false, stream: null })
      return true
    }

    nextLoadSeq(topicId)
    patchSession(topicId, {
      loading: false,
      messages: [...turn.History, turn.UserMessage, turn.AssistantMessage],
    })

    void executeTurn({
      topicId,
      runId,
      message: turn.AssistantMessage,
      assistant: turn.Assistant,
      provider: turn.Provider,
      model: turn.Model,
      history: turn.History,
      userText: messageText(turn.UserMessage),
      controller,
    })

    return true
  },

  async switchSibling(messageId, direction) {
    const topicId = get().activeTopicId
    const session = sessionOf(topicId)
    if (session.generating) return
    const tree = session.tree
    if (!topicId || !tree) return
    const node = tree.Nodes.find((n) => n.ID === messageId)
    if (!node) return
    const siblings = tree.Nodes
      .filter((n) => n.ParentID === node.ParentID)
      .sort((a, b) => a.SiblingIndex - b.SiblingIndex)
    const at = siblings.findIndex((n) => n.ID === messageId)
    const next = direction === 'prev' ? at - 1 : at + 1
    if (at < 0 || next < 0 || next >= siblings.length) {
      useUiStore.getState().showToast('没有其它版本可切换', 'info')
      return
    }
    try {
      // 切换变体后由后端下探到该分支最深处，避免同一位置留下半截路径
      await appApi.SwitchToBranch(topicId, siblings[next].ID)
    } catch (err) {
      useUiStore.getState().showToast(`切换分支失败：${describeError(err)}`, 'error')
      return
    }
    await get().refresh()
  },

  async switchActiveNode(messageId) {
    const topicId = get().activeTopicId
    if (sessionOf(topicId).generating) return
    if (!topicId) return
    try {
      await appApi.SetActiveNode(topicId, messageId)
    } catch (err) {
      useUiStore.getState().showToast(`切换节点失败：${describeError(err)}`, 'error')
      return
    }
    await get().refresh()
  },

  async refresh() {
    const topicId = get().activeTopicId
    if (!topicId) return
    // 生成中不动消息列表：流式回调仍以现有数组为准，只同步树
    if (sessionOf(topicId).generating) {
      await get().refreshTree()
      return
    }
    patchSession(topicId, { loading: true })
    const seq = nextLoadSeq(topicId)
    await loadMessages(topicId, seq)
    await loadTree(topicId, seq)
  },

  async refreshTree() {
    const topicId = get().activeTopicId
    if (!topicId) return
    await loadTree(topicId, nextLoadSeq(topicId))
  },

  async deleteMessages(ids) {
    const ui = useUiStore.getState()
    if (ids.length === 0) return
    let removed: number
    try {
      removed = await appApi.DeleteMessages(ids)
    } catch (err) {
      ui.showToast(`删除消息失败：${describeError(err)}`, 'error')
      return
    }
    await get().refresh()
    // 话题列表上的消息数角标随之变化，失败不影响对话
    void ui.refreshTopics().catch(() => {})
    ui.showToast(`已删除 ${removed} 条消息`, 'success')
  },

  siblingsFor(messageId) {
    const tree = sessionOf(get().activeTopicId).tree
    if (!tree) return null
    const node = tree.Nodes.find((n) => n.ID === messageId)
    if (!node) return null
    const siblings = tree.Nodes
      .filter((n) => n.ParentID === node.ParentID)
      .sort((a, b) => a.SiblingIndex - b.SiblingIndex)
    if (siblings.length <= 1) return null
    const at = siblings.findIndex((n) => n.ID === messageId)
    if (at < 0) return null
    return {
      count: siblings.length,
      index: at + 1,
      onPrev: () => {
        void get().switchSibling(messageId, 'prev')
      },
      onNext: () => {
        void get().switchSibling(messageId, 'next')
      },
    }
  },
}))

/** 复制文本：优先 Clipboard API，WebView 受限时回退到临时节点。 */
export async function copyToClipboard(text: string): Promise<void> {
  const ui = useUiStore.getState()
  if (!text) {
    ui.showToast('没有可复制的内容', 'info')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    ui.showToast('已复制', 'success')
    return
  } catch {
    /* 继续尝试回退方案 */
  }
  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(holder)
    ui.showToast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error')
  } catch {
    ui.showToast('复制失败', 'error')
  }
}
