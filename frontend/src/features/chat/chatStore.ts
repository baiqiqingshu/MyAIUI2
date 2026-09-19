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
import { searchContextFor } from '../search/searchAdapter'

/* 对话状态：只保留瞬时 UI 状态（当前话题的消息、流式增量、开关），
   持久化一律走 AppAPI；不写 localStorage。 */

const HISTORY_LIMIT = 50
const SNAPSHOT_INTERVAL_MS = 1000

/** 流式中的助手消息：prefix 为搜索引用等前置片段，parts 为引擎实时增量。 */
export interface StreamState {
  messageId: string
  prefix: MessagePart[]
  parts: MessagePart[]
}

/** 兄弟变体导航信息：同一父节点下的多个子节点互为兄弟。 */
export interface SiblingNav {
  count: number
  index: number
  onPrev: () => void
  onNext: () => void
}

interface ChatState {
  topicId: string
  messages: MessageDTO[]
  tree: TopicTreeDTO | null
  loading: boolean
  generating: boolean
  stream: StreamState | null
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
  siblingsFor: (messageId: string) => SiblingNav | null
}

// 运行序号 + 当前 AbortController：话题切换/新一轮生成都会让旧回调失效。
let runSeq = 0
let activeAbort: AbortController | null = null

function isCurrentRun(runId: number, topicId: string): boolean {
  return runSeq === runId && useChatStore.getState().topicId === topicId
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

/** 联网搜索：失败不阻断对话，只提示并按“无搜索上下文”继续。 */
async function searchStep(query: string): Promise<{ prefix: MessagePart[]; contextText: string }> {
  try {
    const { results, contextText } = await searchContextFor(query)
    const prefix: MessagePart[] = results.map((item) => ({
      type: 'search-result',
      title: item.Title,
      url: item.URL,
      snippet: item.Snippet,
    }))
    return { prefix, contextText }
  } catch (err) {
    useUiStore.getState().showToast(`联网搜索失败，已按无搜索结果继续：${describeError(err)}`, 'error')
    return { prefix: [], contextText: '' }
  }
}

/** 单轮生成：逐增量刷新 UI + 节流快照，返回最终片段与状态。 */
async function generateOnce(
  run: TurnRun & { prefix: MessagePart[]; searchContext: string },
): Promise<TurnOutcome> {
  const { topicId, runId, message, assistant, provider, model, history, userText, prefix, searchContext } = run
  const signal = run.controller.signal

  let latest: MessagePart[] = []
  const saver = createSnapshotSaver(message.ID)

  const publish = (parts: MessagePart[]) => {
    latest = parts
    if (isCurrentRun(runId, topicId)) {
      useChatStore.setState({ stream: { messageId: message.ID, prefix, parts } })
    }
    saver.push(prefix.concat(parts))
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
        searchContext,
        signal,
        onParts: publish,
      })
      publish(parts)
    }
  } catch (err) {
    if (signal.aborted) {
      saver.dispose()
      return { parts: prefix.concat(latest), status: 'cancelled', errorCode: '', errorMessage: '' }
    }
    const raw = describeError(err)
    const code = model.Modality === 'image' ? 'image-failed' : 'chat-failed'
    const errorPart: MessagePart = { type: 'error', code, message: raw }
    publish([...latest, errorPart])
    saver.dispose()
    return { parts: prefix.concat(latest), status: 'error', errorCode: code, errorMessage: raw }
  }

  saver.dispose()
  return {
    parts: prefix.concat(latest),
    status: signal.aborted ? 'cancelled' : 'done',
    errorCode: '',
    errorMessage: '',
  }
}

/** 执行一轮：搜索 → 生成 → FinishTurn → 更新本地状态。由 send/regenerate 触发，不阻塞输入。 */
async function executeTurn(run: TurnRun) {
  const { topicId, runId, message, model, userText, controller } = run
  const signal = controller.signal
  const state = useChatStore.getState()

  const search =
    state.searchEnabled && model.Modality !== 'image' && !signal.aborted
      ? await searchStep(userText)
      : { prefix: [] as MessagePart[], contextText: '' }

  if (!isCurrentRun(runId, topicId) || signal.aborted) {
    await finishCancelled(message.ID)
    if (isCurrentRun(runId, topicId)) {
      // 生成前就被停止：复位“生成中”，话题切换的情况已由 setTopic 复位
      useChatStore.setState({ generating: false, stream: null })
    }
    return
  }

  const outcome = await generateOnce({ ...run, prefix: search.prefix, searchContext: search.contextText })

  if (activeAbort === controller) activeAbort = null

  try {
    await appApi.FinishTurn({
      MessageID: message.ID,
      PartsJSON: JSON.stringify(outcome.parts),
      Status: outcome.status,
      ErrorCode: outcome.errorCode,
      ErrorMessage: outcome.errorMessage,
    })
  } catch (err) {
    if (isCurrentRun(runId, topicId)) {
      useUiStore.getState().showToast(`保存回复失败：${describeError(err)}`, 'error')
    }
  }

  if (isCurrentRun(runId, topicId)) {
    const partsJSON = JSON.stringify(outcome.parts)
    useChatStore.setState((prev) => ({
      generating: false,
      stream: null,
      messages: prev.messages.map((item) =>
        item.ID === message.ID
          ? { ...item, PartsJSON: partsJSON, Status: outcome.status, UpdatedAt: Date.now() }
          : item,
      ),
    }))
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

  // 一轮对话可能产生新分支（重新生成/编辑发送），同步消息树
  void useChatStore.getState().refreshTree()
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

async function loadMessages(topicId: string, runId: number) {
  try {
    const messages = await appApi.ListMessages(topicId, 0, HISTORY_LIMIT)
    if (!isCurrentRun(runId, topicId)) return
    useChatStore.setState({ messages, loading: false })
  } catch (err) {
    if (!isCurrentRun(runId, topicId)) return
    useChatStore.setState({ loading: false })
    useUiStore.getState().showToast(`加载消息失败：${describeError(err)}`, 'error')
  }
}

/** 消息树只服务于分支 UI，取不到时静默降级（不显示兄弟导航）。 */
async function loadTree(topicId: string, runId: number) {
  try {
    const tree = await appApi.GetTopicTree(topicId)
    if (!isCurrentRun(runId, topicId)) return
    useChatStore.setState({ tree })
  } catch {
    /* 静默：分支 UI 不是对话主链路 */
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  topicId: '',
  messages: [],
  tree: null,
  loading: false,
  generating: false,
  stream: null,
  searchEnabled: false,

  setTopic(topicId) {
    if (get().topicId === topicId) return
    // 切换话题：终止旧生成，并让旧流的回调全部失效
    activeAbort?.abort()
    activeAbort = null
    runSeq += 1
    set({ topicId, messages: [], tree: null, stream: null, generating: false, loading: topicId !== '' })
    if (topicId) {
      void loadMessages(topicId, runSeq)
      void loadTree(topicId, runSeq)
    }
  },

  setSearchEnabled(enabled) {
    set({ searchEnabled: enabled })
  },

  syncSearchDefault(enabled) {
    set({ searchEnabled: enabled })
  },

  async send(text) {
    const trimmed = text.trim()
    if (!trimmed || get().generating) return false

    const topicId = get().topicId
    const ui = useUiStore.getState()
    if (!topicId) {
      ui.showToast('请先新建话题', 'error')
      return false
    }
    // 活动路径停在用户消息上（在历史节点回退所致）：直接续写会形成 (user,user) 畸形路径
    const tail = get().messages[get().messages.length - 1]
    if (tail && tail.Role === 'user') {
      ui.showToast('当前停在用户消息上：请用它的「编辑并重新发送」，或在分支面板选择其它节点', 'info')
      return false
    }
    const target = resolveTarget()
    if (!target) return false

    runSeq += 1
    const runId = runSeq
    const controller = new AbortController()
    activeAbort = controller
    set({ generating: true })

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
      if (isCurrentRun(runId, topicId)) set({ generating: false })
      useUiStore.getState().showToast(`发送失败：${describeError(err)}`, 'error')
      return false
    }

    if (!isCurrentRun(runId, topicId)) {
      // 期间切换了话题：本轮占位消息直接按取消收尾
      await finishCancelled(turn.AssistantMessage.ID)
      return true
    }

    set((prev) => ({ messages: [...prev.messages, turn.UserMessage, turn.AssistantMessage] }))
    void useUiStore.getState().refreshTopics().catch(() => {
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
    activeAbort?.abort()
  },

  async regenerate(assistantMessageId) {
    if (get().generating) return false
    const topicId = get().topicId
    if (!topicId) return false

    // 重新生成 = 给该助手消息的父用户消息再建一个助手子节点，旧回答作为兄弟变体保留
    const source = get().messages.find((m) => m.ID === assistantMessageId)
    const parentMessageId = source?.ParentID ?? ''
    if (!source || !parentMessageId) {
      useUiStore.getState().showToast('无法确定要重新回答的问题', 'error')
      return false
    }

    const target = resolveTarget()
    if (!target) return false

    runSeq += 1
    const runId = runSeq
    const controller = new AbortController()
    activeAbort = controller
    set({ generating: true })

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
      if (isCurrentRun(runId, topicId)) {
        set({ generating: false })
        void loadMessages(topicId, runId)
      }
      useUiStore.getState().showToast(`重新生成失败：${describeError(err)}`, 'error')
      return false
    }

    if (!isCurrentRun(runId, topicId)) {
      await finishCancelled(turn.AssistantMessage.ID)
      return true
    }

    set({ messages: [...turn.History, turn.UserMessage, turn.AssistantMessage] })

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
    if (!trimmed || get().generating) return false
    const topicId = get().topicId
    const ui = useUiStore.getState()
    if (!topicId) {
      ui.showToast('请先新建话题', 'error')
      return false
    }
    const target = resolveTarget()
    if (!target) return false

    runSeq += 1
    const runId = runSeq
    const controller = new AbortController()
    activeAbort = controller
    set({ generating: true })

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
      if (isCurrentRun(runId, topicId)) set({ generating: false })
      useUiStore.getState().showToast(`编辑发送失败：${describeError(err)}`, 'error')
      return false
    }

    if (!isCurrentRun(runId, topicId)) {
      // 期间切换了话题：本轮占位消息直接按取消收尾
      await finishCancelled(turn.AssistantMessage.ID)
      return true
    }

    set({ messages: [...turn.History, turn.UserMessage, turn.AssistantMessage] })

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
    if (get().generating) return
    const topicId = get().topicId
    const tree = get().tree
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
    if (get().generating) return
    const topicId = get().topicId
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
    const topicId = get().topicId
    if (!topicId) {
      set({ messages: [], tree: null, loading: false })
      return
    }
    // 生成中不动消息列表：流式回调仍以现有数组为准，只同步树
    if (get().generating) {
      await get().refreshTree()
      return
    }
    set({ loading: true })
    await loadMessages(topicId, runSeq)
    await get().refreshTree()
  },

  async refreshTree() {
    const topicId = get().topicId
    if (!topicId) {
      set({ tree: null })
      return
    }
    try {
      const tree = await appApi.GetTopicTree(topicId)
      if (get().topicId !== topicId) return
      set({ tree })
    } catch {
      /* 静默：分支 UI 不是对话主链路 */
    }
  },

  siblingsFor(messageId) {
    const tree = get().tree
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
