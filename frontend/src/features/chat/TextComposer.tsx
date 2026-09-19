import { Send, Square } from 'lucide-react'
import { Button, Select, Textarea, type SelectOption } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import { useChatStore } from './chatStore'
import { SearchToggle } from '../search/SearchToggle'
import type { SaveAssistantDTO } from '../../domain/dto'

export interface TextComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled?: boolean
}

/* 纯文本输入器：粘贴只接受 text/plain（含文件/图片的粘贴由 bootstrap 全局拦截并提示）。 */
export function TextComposer({ value, onChange, onSend, disabled }: TextComposerProps) {
  const assistants = useUiStore((s) => s.assistants)
  const activeAssistantId = useUiStore((s) => s.activeAssistantId)
  const models = useUiStore((s) => s.models)
  const providers = useUiStore((s) => s.providers)
  const refreshAssistants = useUiStore((s) => s.refreshAssistants)
  const showToast = useUiStore((s) => s.showToast)

  const generating = useChatStore((s) => s.generating)
  const searchEnabled = useChatStore((s) => s.searchEnabled)
  const setSearchEnabled = useChatStore((s) => s.setSearchEnabled)
  const stop = useChatStore((s) => s.stop)

  const assistant = assistants.find((a) => a.ID === activeAssistantId)

  const options: SelectOption[] = models
    .filter((m) => m.Enabled)
    .map((m) => ({
      value: m.ID,
      label: `${providers.find((p) => p.ID === m.ProviderID)?.Name ?? '未知服务'} / ${m.DisplayName}`,
    }))

  const currentModelId = options.some((o) => o.value === assistant?.ModelID) ? (assistant?.ModelID ?? '') : ''
  const canSend = !generating && !disabled && value.trim().length > 0

  const onModelChange = (modelId: string) => {
    if (!assistant) return
    const model = models.find((m) => m.ID === modelId)
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
    <div className="chat-composer">
      <div className="chat-composer__toolbar">
        <Select
          value={currentModelId}
          onChange={onModelChange}
          options={options}
          disabled={generating || options.length === 0 || !assistant}
          placeholder={options.length === 0 ? '暂无可用模型' : '选择模型'}
        />
        <SearchToggle enabled={searchEnabled} onChange={setSearchEnabled} />
      </div>
      <Textarea
        value={value}
        onChange={onChange}
        rows={3}
        className="chat-composer__input"
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
            ? '已开启联网：本次提问会发送到你配置的搜索服务 · 仅支持纯文本，图片/文件粘贴会被拒绝'
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
  )
}
