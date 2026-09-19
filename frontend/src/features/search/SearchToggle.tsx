import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Globe } from 'lucide-react'
import './search.css'
import { Button, Field, Input, Modal, Select, Toggle } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { SaveSearchSettingsDTO } from '../../domain/dto'

const MAX_RESULT_OPTIONS = Array.from({ length: 10 }, (_, index) => ({
  value: String(index + 1),
  label: `${index + 1} 条`,
}))

// 输入区工具栏的联网开关：状态由调用方（聊天页）持有。
export function SearchToggle({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      className={clsx('search-toggle', enabled && 'is-on')}
      title="开启联网后，本次提问会发送到你配置的搜索服务"
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
    >
      <Globe size={13} />
      联网
    </button>
  )
}

export function SearchSettingsDialog() {
  const drawer = useUiStore((s) => s.drawer)
  const search = useUiStore((s) => s.search)
  const setSearchSettings = useUiStore((s) => s.setSearchSettings)
  const closeDrawer = useUiStore((s) => s.closeDrawer)
  const showToast = useUiStore((s) => s.showToast)

  const open = drawer.kind === 'search'
  const [enabled, setEnabled] = useState(search.Enabled)
  const [baseURL, setBaseURL] = useState(search.BaseURL)
  const [apiKey, setAPIKey] = useState('')
  const [clearAPIKey, setClearAPIKey] = useState(false)
  const [maxResults, setMaxResults] = useState(search.MaxResults || 5)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setEnabled(search.Enabled)
    setBaseURL(search.BaseURL)
    setAPIKey('')
    setClearAPIKey(false)
    setMaxResults(search.MaxResults || 5)
  }, [open, search])

  async function handleSave() {
    const trimmed = baseURL.trim().replace(/\/+$/, '')
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      showToast('BaseURL 必须是 http/https 地址', 'error')
      return
    }
    if (enabled && !trimmed) {
      showToast('开启联网前请先填写搜索服务地址', 'error')
      return
    }
    const input: SaveSearchSettingsDTO = {
      Enabled: enabled,
      ServiceID: search.ServiceID || 'searxng',
      BaseURL: trimmed,
      APIKey: apiKey.trim(),
      ClearAPIKey: clearAPIKey,
      MaxResults: maxResults,
    }
    setSaving(true)
    try {
      const saved = await appApi.SaveSearchSettings(input)
      setSearchSettings(saved)
      showToast('搜索设置已保存', 'success')
      closeDrawer()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showToast(`保存失败：${message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title="联网搜索"
      onClose={closeDrawer}
      width={480}
      footer={
        <>
          <Button onClick={closeDrawer} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSave} loading={saving}>
            保存
          </Button>
        </>
      }
    >
      <div className="search-dialog">
        <p className="search-dialog__notice">
          开启联网后，本次提问会发送到你配置的搜索服务；搜索结果会作为不可信外部内容提供给模型参考。
        </p>
        <Toggle checked={enabled} onChange={setEnabled} label="启用联网搜索" />
        <Field label="搜索服务地址" hint="SearXNG 实例地址，例如 http://10.0.0.5:8080">
          <Input value={baseURL} onChange={setBaseURL} placeholder="http://10.0.0.5:8080" />
        </Field>
        <Field
          label="API Key（可选）"
          hint={search.HasAPIKey ? '已配置密钥，留空表示不修改' : '自建 SearXNG 通常无需密钥'}
        >
          <Input
            type="password"
            value={apiKey}
            onChange={setAPIKey}
            placeholder={search.HasAPIKey ? '已配置，留空表示不修改' : '可留空'}
            disabled={clearAPIKey}
          />
        </Field>
        {search.HasAPIKey ? (
          <Toggle checked={clearAPIKey} onChange={setClearAPIKey} label="清除已保存的密钥" />
        ) : null}
        <Field label="最大结果数">
          <Select
            value={String(maxResults)}
            onChange={(value) => setMaxResults(Number(value))}
            options={MAX_RESULT_OPTIONS}
          />
        </Field>
      </div>
    </Modal>
  )
}
