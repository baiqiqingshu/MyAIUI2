import { useEffect, useRef, useState, type ReactElement } from 'react'
import { GitBranch, Maximize2, Minimize2, PlugZap } from 'lucide-react'
import clsx from 'clsx'
import { Button, EmptyState, IconButton } from '../../components/ui'
import { selectUsableModels, useUiStore } from '../../app/uiStore'
import { useLayoutStore } from '../../app/layoutStore'
import { copyToClipboard, EMPTY_SESSION, useChatStore } from './chatStore'
import { MessageList } from './MessageList'
import { MessageDots } from './MessageDots'
import { TextComposer } from './TextComposer'
import { BranchPanel } from '../branches/BranchPanel'
import './chat.css'

/* 单一对话工作台：顶栏（助手/话题）+ 消息列表 + 纯文本输入器。 */
export function ChatWorkspace(): ReactElement {
  const assistants = useUiStore((s) => s.assistants)
  const topics = useUiStore((s) => s.topics)
  const providers = useUiStore((s) => s.providers)
  const models = useUiStore((s) => s.models)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const activeTopicId = useUiStore((s) => s.activeTopicId)
  const setMainView = useUiStore((s) => s.setMainView)

  // 当前话题的会话：生成中的话题切走再切回时，stream/generating 原样保留。
  const session = useChatStore((s) => s.sessions[s.activeTopicId] ?? EMPTY_SESSION)
  const { messages, tree, loading, generating, stream } = session
  const setTopic = useChatStore((s) => s.setTopic)
  const send = useChatStore((s) => s.send)
  const regenerate = useChatStore((s) => s.regenerate)
  const editAndResend = useChatStore((s) => s.editAndResend)
  const syncSearchDefault = useChatStore((s) => s.syncSearchDefault)
  // 布局偏好：消息列铺满宽度开关（layoutStore 持久化，仅 UI 偏好）
  const chatFullWidth = useLayoutStore((s) => s.chatFullWidth)
  const setChatFullWidth = useLayoutStore((s) => s.setChatFullWidth)

  const assistant = assistants.find((a) => a.ID === activeAssistantId)
  const topic = topics.find((t) => t.ID === activeTopicId)
  // 可用模型 = 模型启用且所属服务商启用；只有存在可用模型才允许发送/重新生成。
  const hasUsableModel = selectUsableModels(models, providers).length > 0
  const hasEnabledProvider = providers.some((p) => p.Enabled)

  const [draft, setDraft] = useState('')
  const [branchOpen, setBranchOpen] = useState(false)
  /* 消息滚动容器：同时交给 MessageList（贴底）与 MessageDots（观察/定位）。 */
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setTopic(activeTopicId)
  }, [activeTopicId, setTopic])

  useEffect(() => {
    setDraft('')
  }, [activeTopicId])

  useEffect(() => {
    syncSearchDefault(assistant?.WebSearchDefault ?? false)
  }, [assistant?.ID, assistant?.WebSearchDefault, syncSearchDefault])

  const openProviders = () => setMainView('models')
  const providerGuide = !hasUsableModel

  return (
    <div className={clsx('chat', chatFullWidth && 'chat--full')}>
      <header className="chat-header">
        <span className="chat-header__emoji" aria-hidden>
          {assistant?.Emoji || '🤖'}
        </span>
        <div className="chat-header__meta">
          <div className="chat-header__name">{assistant?.Name || '未选择助手'}</div>
          <div className="chat-header__topic" title={topic?.Title}>
            {topic?.Title || '未选择话题'}
          </div>
        </div>
        <div className="chat-header__actions">
          <IconButton
            title={chatFullWidth ? '默认宽度' : '铺满宽度'}
            active={chatFullWidth}
            onClick={() => setChatFullWidth(!chatFullWidth)}
          >
            {chatFullWidth ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          <Button
            size="sm"
            disabled={!activeTopicId}
            title="查看并切换话题内的分支"
            onClick={() => setBranchOpen(true)}
          >
            <span className="chat-header__action-icon">
              <GitBranch size={13} />
            </span>
            <span>分支</span>
            <span className="chat-header__badge">{tree?.Nodes.length ?? 0}</span>
          </Button>
        </div>
      </header>

      <MessageList
        scrollRef={scrollRef}
        messages={messages}
        loading={loading}
        stream={stream}
        canRegenerate={!generating && hasUsableModel}
        onCopy={(text) => {
          void copyToClipboard(text)
        }}
        onRegenerate={(messageId) => {
          void regenerate(messageId)
        }}
        onEdit={(messageId, text) => editAndResend(messageId, text)}
        editDisabled={generating}
        empty={
          !activeTopicId ? (
            <EmptyState title="还没有话题" description="在左侧话题栏新建一个话题，然后开始对话。" />
          ) : providerGuide ? (
            <EmptyState
              icon={<PlugZap size={22} />}
              title={providers.length === 0 ? '还没有配置模型服务' : '没有可用的模型'}
              description={
                providers.length === 0
                  ? '添加一个 OpenAI 兼容的模型服务，同步模型后即可开始对话。'
                  : hasEnabledProvider
                    ? '请在模型服务中启用或同步模型。'
                    : '模型服务已停用，请在「模型服务」中重新启用。'
              }
              action={
                <Button variant="primary" onClick={openProviders}>
                  打开模型服务
                </Button>
              }
            />
          ) : (
            <EmptyState title="开始新的对话" description="输入问题后按 Enter 发送；需要联网时可开启联网开关。" />
          )
        }
      />

      <MessageDots scrollRef={scrollRef} />

      {providerGuide && activeTopicId && messages.length > 0 ? (
        <div className="chat-notice">
          <span>当前没有可用模型，无法继续发送。</span>
          <Button size="sm" onClick={openProviders}>
            打开模型服务
          </Button>
        </div>
      ) : null}

      <TextComposer
        value={draft}
        onChange={setDraft}
        disabled={!activeTopicId || providerGuide}
        onSend={() => {
          const text = draft.trim()
          if (!text) return
          void send(text).then((started) => {
            if (started) setDraft('')
          })
        }}
      />

      <BranchPanel open={branchOpen} onClose={() => setBranchOpen(false)} />
    </div>
  )
}
