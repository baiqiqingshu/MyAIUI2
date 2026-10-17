import { useState } from 'react'
import { Copy, X } from 'lucide-react'
import { Button, Field, IconButton, Input, Select, Toggle } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { ProviderDTO, SaveProviderDTO } from '../../domain/dto'
import { describeError } from './errors'

type ProviderKind = 'openai-compatible' | 'openai' | 'openai-responses'

// 预设模板只填静态地址信息，不触发任何网络访问，也不改协议：
// 接口协议由下面的「接口协议」下拉单独选择，模板与协议不重复表达同一件事。
interface ProviderTemplate {
  id: string
  label: string
  displayName: string
  baseURL: string
  modelPath: string
  local: boolean
}

const TEMPLATES: ProviderTemplate[] = [
  { id: 'openai', label: 'OpenAI', displayName: 'OpenAI', baseURL: 'https://api.openai.com/v1', modelPath: '/models', local: false },
  { id: 'deepseek', label: 'DeepSeek', displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', modelPath: '/models', local: false },
  { id: 'openrouter', label: 'OpenRouter', displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', modelPath: '/models', local: false },
  { id: 'ollama', label: 'Ollama（本地，无需 Key）', displayName: 'Ollama', baseURL: 'http://localhost:11434/v1', modelPath: '/models', local: true },
  { id: 'lmstudio', label: 'LM Studio（本地，无需 Key）', displayName: 'LM Studio', baseURL: 'http://localhost:1234/v1', modelPath: '/models', local: true },
  { id: 'custom', label: '自定义（留空手动填写）', displayName: '', baseURL: '', modelPath: '/models', local: false },
]

const TEMPLATE_OPTIONS = TEMPLATES.map((t) => ({ value: t.id, label: t.label }))

const KIND_OPTIONS = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（/chat/completions）' },
  { value: 'openai', label: 'OpenAI 原生（/chat/completions）' },
  { value: 'openai-responses', label: 'OpenAI Responses（/v1/responses）' },
]

const DEFAULT_KIND: ProviderKind = 'openai-compatible'

// 模板只按地址匹配（协议是独立字段，不参与模板判定）。
function matchTemplate(baseURL: string): string {
  const found = TEMPLATES.find((t) => t.id !== 'custom' && t.baseURL === baseURL)
  return found ? found.id : 'custom'
}

export function ProviderForm({
  provider,
  onCancel,
  onSaved,
}: {
  provider?: ProviderDTO
  onCancel: () => void
  onSaved: (saved: ProviderDTO) => void
}) {
  const refreshProviders = useUiStore((s) => s.refreshProviders)
  const refreshModels = useUiStore((s) => s.refreshModels)
  const showToast = useUiStore((s) => s.showToast)

  const [templateId, setTemplateId] = useState(() => matchTemplate(provider?.BaseURL ?? ''))
  const [name, setName] = useState(provider?.Name ?? '')
  const [baseURL, setBaseURL] = useState(provider?.BaseURL ?? '')
  const [kind, setKind] = useState<string>(provider?.Kind || DEFAULT_KIND)
  const [modelPath, setModelPath] = useState(provider?.ModelPath || '/models')
  const [apiKey, setAPIKey] = useState('')
  const [clearAPIKey, setClearAPIKey] = useState(false)
  const [enabled, setEnabled] = useState(provider?.Enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [copyingKey, setCopyingKey] = useState(false)

  const template = TEMPLATES.find((t) => t.id === templateId)
  const hasStoredKey = !!provider?.HasAPIKey

  function applyTemplate(id: string) {
    setTemplateId(id)
    const next = TEMPLATES.find((t) => t.id === id)
    if (!next || next.id === 'custom') return
    setName((current) => current || next.displayName)
    setBaseURL(next.baseURL)
    setModelPath(next.modelPath)
  }

  async function handleCopyKey() {
    const id = provider?.ID
    if (!id) return
    setCopyingKey(true)
    try {
      // 后端只返回是否成功，密钥本身不经过前端。
      await appApi.CopyProviderAPIKey(id)
      showToast('API Key 已复制到剪贴板', 'success')
    } catch (error) {
      showToast(`复制失败：${describeError(error)}`, 'error')
    } finally {
      setCopyingKey(false)
    }
  }

  async function handleSave() {
    const trimmedName = name.trim()
    const trimmedBase = baseURL.trim().replace(/\/+$/, '')
    if (!trimmedName) {
      showToast('请填写服务商名称', 'error')
      return
    }
    if (!/^https?:\/\//i.test(trimmedBase)) {
      showToast('BaseURL 必须是 http/https 地址', 'error')
      return
    }
    const input: SaveProviderDTO = {
      ID: provider?.ID ?? '',
      Name: trimmedName,
      Kind: kind,
      BaseURL: trimmedBase,
      APIKey: apiKey.trim(),
      ClearAPIKey: clearAPIKey,
      Enabled: enabled,
      ModelPath: modelPath.trim() || '/models',
    }
    setSaving(true)
    try {
      const saved = await appApi.SaveProvider(input)
      await refreshProviders()
      await refreshModels()
      showToast('服务商已保存', 'success')
      onSaved(saved)
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const keyHint = hasStoredKey
    ? '已配置密钥，留空表示不修改；密钥不可见，可用「复制密钥」取出'
    : template?.local
      ? '本地服务通常无需 API Key'
      : '可留空；密钥仅保存在本机（DPAPI 加密）'

  return (
    <div className="provider-form">
      <div className="provider-form__head">
        <h2 className="provider-form__title">{provider ? '编辑服务商' : '添加服务商'}</h2>
        <IconButton title="取消" onClick={onCancel} disabled={saving}>
          <X size={16} />
        </IconButton>
      </div>
      <Field label="预设模板" hint="仅用于快速填充地址，不会自动联网校验">
        <Select value={templateId} onChange={applyTemplate} options={TEMPLATE_OPTIONS} />
      </Field>
      <Field label="名称">
        <Input value={name} onChange={setName} placeholder="例如：我的 OpenAI" />
      </Field>
      <Field label="BaseURL" hint="接口地址，通常以 /v1 结尾">
        <Input value={baseURL} onChange={setBaseURL} placeholder="https://api.openai.com/v1" />
      </Field>
      <Field label="接口协议" hint="Responses 仅适用于支持 /v1/responses 的服务">
        <Select value={kind} onChange={setKind} options={KIND_OPTIONS} />
      </Field>
      <Field label="API Key" hint={keyHint}>
        <div className="ui-field__row">
          <Input
            type="password"
            value={apiKey}
            onChange={setAPIKey}
            placeholder={hasStoredKey ? '已配置，留空表示不修改' : '请输入 API Key（可留空）'}
            disabled={clearAPIKey}
          />
          {hasStoredKey ? (
            <Button
              size="sm"
              variant="ghost"
              loading={copyingKey}
              title="把已保存的密钥复制到系统剪贴板（密钥不会显示在界面上）"
              onClick={handleCopyKey}
            >
              <Copy size={13} />
              复制密钥
            </Button>
          ) : null}
        </div>
      </Field>
      {hasStoredKey ? (
        <Toggle checked={clearAPIKey} onChange={setClearAPIKey} label="清除已保存的密钥" />
      ) : null}
      <Field label="模型路径" hint="用于测试连接与同步模型，默认 /models">
        <Input value={modelPath} onChange={setModelPath} placeholder="/models" />
      </Field>
      <Toggle checked={enabled} onChange={setEnabled} label="启用该服务商" />
      <div className="provider-form__actions">
        <Button onClick={onCancel} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" onClick={handleSave} loading={saving}>
          保存
        </Button>
      </div>
    </div>
  )
}
