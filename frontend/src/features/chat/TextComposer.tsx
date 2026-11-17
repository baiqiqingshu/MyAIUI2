import { Globe, Send, Square } from 'lucide-react'
import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Textarea } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { selectUsableModels, useUiStore } from '../../app/uiStore'
import { useChatStore } from './chatStore'
import { ModelSelect } from './ModelSelect'
import type { SaveAssistantDTO } from '../../domain/dto'

export interface TextComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
}

/* 输入框高度下限与 .chat-composer__input 的 min-height 保持一致，避免拖动出现视觉跳变。 */
const MIN_INPUT_HEIGHT = 68
const MAX_INPUT_HEIGHT = 480
const KEYBOARD_RESIZE_STEP = 24

/* 上限取「窗口高度 60%」与 480px 的较小值：再高就会把消息区挤没。 */
function maxInputHeight(): number {
  return Math.min(MAX_INPUT_HEIGHT, Math.round(window.innerHeight * 0.6))
}

function clampInputHeight(height: number): number {
  return Math.min(Math.max(Math.round(height), MIN_INPUT_HEIGHT), maxInputHeight())
}

/* 纯文本输入器：粘贴只接受 text/plain（含文件/图片的粘贴由 bootstrap 全局拦截并提示）。
   高度由输入区上边沿的拖动条控制（不再使用原生右下角 resize 手柄）。 */
export function TextComposer({ value, onChange, onSend, disabled }: TextComposerProps) {
  const assistants = useUiStore((s) => s.assistants)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const models = useUiStore((s) => s.models)
  const providers = useUiStore((s) => s.providers)
  const refreshAssistants = useUiStore((s) => s.refreshAssistants)
  const showToast = useUiStore((s) => s.showToast)

  // 发送/停止按钮只看当前话题的会话：别的话题在生成不阻塞这里。
  const generating = useChatStore((s) => s.sessions[s.activeTopicId]?.generating ?? false)
  const searchEnabled = useChatStore((s) => s.searchEnabled)
  const setSearchEnabled = useChatStore((s) => s.setSearchEnabled)
  const stop = useChatStore((s) => s.stop)

  const rootRef = useRef<HTMLDivElement>(null)
  /* null＝沿用 rows={3} 的自然高度（首帧测量前）；之后由自动增高逻辑写入像素值。 */
  const [inputHeight, setInputHeight] = useState<number | null>(null)
  /* 手动拖动得到的高度下限（null＝没拖过）：自动增高只把它当最小值，内容更高仍可顶到上限。 */
  const [manualHeight, setManualHeight] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)
  const selectLockedRef = useRef(false)

  const assistant = assistants.find((a) => a.ID === activeAssistantId)

  // 服务商被停用后，它的模型必须立刻从下拉里消失（见 selectUsableModels 的契约）。
  const usableModels = selectUsableModels(models, providers)

  const currentModelId = usableModels.some((m) => m.ID === assistant?.ModelID)
    ? (assistant?.ModelID ?? '')
    : ''
  const canSend = !generating && !disabled && value.trim().length > 0

  const lockTextSelection = (locked: boolean) => {
    if (locked) {
      document.body.style.userSelect = 'none'
      selectLockedRef.current = true
      return
    }
    if (!selectLockedRef.current) return
    document.body.style.userSelect = ''
    selectLockedRef.current = false
  }

  /* 拖动中指针会划过消息区，锁住文本选择；组件在拖动中卸载也要恢复。 */
  useEffect(() => () => lockTextSelection(false), [])

  /* 内容驱动自动增高：先放开高度量 scrollHeight（含内边距、不含边框），
     与手动下限取大后夹进 [MIN_INPUT_HEIGHT, maxInputHeight()]。发送清空后
     内容自然回落到 MIN（或手动下限）。 */
  useLayoutEffect(() => {
    const el = rootRef.current?.querySelector('textarea')
    if (!el) return
    const prev = el.style.height
    el.style.height = 'auto'
    // auto 高（rows=3 自然高）下无横向滚动条，offsetHeight-clientHeight 即上下边框
    const content = el.scrollHeight + (el.offsetHeight - el.clientHeight)
    el.style.height = prev
    setInputHeight(clampInputHeight(Math.max(content, manualHeight ?? MIN_INPUT_HEIGHT)))
  }, [value, manualHeight])

  /* 窗口变矮后原高度可能超出上限，重新夹回区间。 */
  useEffect(() => {
    const onWindowResize = () => {
      setManualHeight((prev) => (prev === null ? prev : clampInputHeight(prev)))
      setInputHeight((prev) => (prev === null ? prev : clampInputHeight(prev)))
    }
    window.addEventListener('resize', onWindowResize)
    return () => window.removeEventListener('resize', onWindowResize)
  }, [])

  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    /* 起点取实际渲染高度：没调过高度时就是 rows={3} 的自然高度。 */
    const inputEl = rootRef.current?.querySelector('textarea')
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: inputEl?.offsetHeight ?? MIN_INPUT_HEIGHT,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizing(true)
    lockTextSelection(true)
  }

  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    /* 向上拖（clientY 变小）＝变高；拖出的是手动下限，内容更高时仍以内容为准。 */
    setManualHeight(clampInputHeight(drag.startHeight + (drag.startY - event.clientY)))
  }

  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setResizing(false)
    lockTextSelection(false)
    /* 拖动条会拿走焦点，拖完还给输入框，避免接着打字时字符丢失。 */
    rootRef.current?.querySelector('textarea')?.focus()
  }

  const onResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const inputEl = rootRef.current?.querySelector('textarea')
    const base = inputHeight ?? inputEl?.offsetHeight ?? MIN_INPUT_HEIGHT
    setManualHeight(clampInputHeight(base + (event.key === 'ArrowUp' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)))
  }

  const onModelChange = (modelId: string) => {
    if (!assistant) return
    const model = usableModels.find((m) => m.ID === modelId)
    if (!model) return
    const input: SaveAssistantDTO = {
      ID: assistant.ID,
      Name: assistant.Name,
      Emoji: assistant.Emoji,
      SystemPrompt: assistant.SystemPrompt,
      ProviderID: model.ProviderID,
      ModelID: model.ID,
      Temperature: assistant.Temperature,
      TemperatureSet: assistant.TemperatureSet,
      WebSearchDefault: assistant.WebSearchDefault,
    }
    void appApi
      .SaveAssistant(input)
      .then(() => refreshAssistants(assistant.ID))
      .catch((err: unknown) => {
        showToast(`保存模型选择失败：${err instanceof Error ? err.message : String(err)}`, 'error')
      })
  }

  return (
    <div className="chat-composer" ref={rootRef}>
      <div
        className={clsx('chat-composer__resize', resizing && 'chat-composer__resize--active')}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整输入框高度"
        aria-valuenow={inputHeight ?? undefined}
        aria-valuemin={MIN_INPUT_HEIGHT}
        aria-valuemax={maxInputHeight()}
        tabIndex={0}
        title="拖动调整输入框高度，双击复位"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onLostPointerCapture={onResizeEnd}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => setManualHeight(null)}
      >
        <span className="chat-composer__resize-grip" aria-hidden="true" />
      </div>
      {/* 工具行 + 输入框 + 底行合为一张圆角卡片；拖动条留在卡片外（.chat-composer 顶部） */}
      <div className="chat-composer__card">
        <div className="chat-composer__toolbar">
          <ModelSelect
            models={usableModels}
            providers={providers}
            value={currentModelId}
            onChange={onModelChange}
            disabled={generating || usableModels.length === 0 || !assistant}
            placeholder={usableModels.length === 0 ? '暂无可用模型' : '选择模型'}
          />
          <button
            type="button"
            className={clsx('search-toggle', searchEnabled && 'is-on')}
            title="开启后，向模型请求中写入联网搜索参数（由模型服务决定是否生效）"
            aria-pressed={searchEnabled}
            onClick={() => setSearchEnabled(!searchEnabled)}
          >
            <Globe size={13} />
            联网
          </button>
        </div>
        <Textarea
          value={value}
          onChange={onChange}
          rows={3}
          className="chat-composer__input"
          style={inputHeight === null ? undefined : { height: `${inputHeight}px` }}
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            if (event.nativeEvent.isComposing) return
            event.preventDefault()
            if (canSend) onSend()
          }}
        />
        <div className="chat-composer__foot">
          <span className="chat-composer__hint">
            {searchEnabled
              ? '已开启联网：将向模型请求写入联网搜索参数（是否生效由模型服务决定） · 仅支持纯文本，图片/文件粘贴会被拒绝'
              : '仅支持纯文本，图片/文件粘贴会被拒绝 · Enter 发送 / Shift+Enter 换行'}
          </span>
          {generating ? (
            <Button variant="secondary" onClick={stop} title="停止生成">
              <Square size={13} />
              停止
            </Button>
          ) : (
            <Button variant="primary" onClick={onSend} disabled={!canSend} title="发送">
              <Send size={14} />
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
