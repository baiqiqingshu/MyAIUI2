import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Network, Plus, Trash } from 'lucide-react'
import './providers.css'
import { Button, ConfirmDialog, IconButton, Toggle } from '../../components/ui'
import { ProviderIcon } from '../../components/icons/ProviderIcon'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { ProviderDTO, RelayStatusDTO, SaveProviderDTO } from '../../domain/dto'
import { describeError } from './errors'
import { ModelList } from './ModelList'
import { ProviderForm } from './ProviderForm'
import { ProxyCard } from './ProxyCard'

// 模型服务主页（主区 tab）：内置中转卡片 + 服务商卡片列表（测试/启停/编辑/删除）+ 展开的模型列表。
export function ProvidersPage() {
  const providers = useUiStore((s) => s.providers)
  const models = useUiStore((s) => s.models)
  const refreshProviders = useUiStore((s) => s.refreshProviders)
  const refreshModels = useUiStore((s) => s.refreshModels)
  const showToast = useUiStore((s) => s.showToast)

  const [editing, setEditing] = useState<ProviderDTO | null>(null)
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [testingId, setTestingId] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<ProviderDTO | null>(null)

  const modelCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const model of models) counts.set(model.ProviderID, (counts.get(model.ProviderID) ?? 0) + 1)
    return counts
  }, [models])

  const formOpen = creating || !!editing

  async function handleTest(provider: ProviderDTO) {
    setTestingId(provider.ID)
    try {
      const result = await appApi.TestProvider(provider.ID)
      if (result.OK) {
        showToast(`连接成功：延迟 ${result.LatencyMs}ms，发现 ${result.ModelCount} 个模型`, 'success')
      } else {
        showToast(`连接失败：${result.Message}`, 'error')
      }
    } catch (error) {
      showToast(`连接失败：${describeError(error)}`, 'error')
    } finally {
      setTestingId('')
    }
  }

  async function handleToggleEnabled(provider: ProviderDTO, enabled: boolean) {
    const input: SaveProviderDTO = {
      ID: provider.ID,
      Name: provider.Name,
      Kind: provider.Kind,
      BaseURL: provider.BaseURL,
      APIKey: '',
      ClearAPIKey: false,
      Enabled: enabled,
      ModelPath: provider.ModelPath,
    }
    setBusyId(provider.ID)
    try {
      await appApi.SaveProvider(input)
      await refreshProviders()
    } catch (error) {
      showToast(`操作失败：${describeError(error)}`, 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handleDelete() {
    const target = deleteTarget
    if (!target) return
    try {
      await appApi.DeleteProvider(target.ID)
      if (expandedId === target.ID) setExpandedId('')
      await refreshProviders()
      await refreshModels()
      showToast('服务商已删除', 'success')
    } catch (error) {
      showToast(`删除失败：${describeError(error)}`, 'error')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="providers-page">
      <header className="providers-page__head">
        <h1 className="providers-page__title">模型服务</h1>
        {formOpen ? null : (
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} />
            添加服务商
          </Button>
        )}
      </header>

      <div className="providers-page__scroll scroll-area">
        <div className="providers-page__inner">
          <RelayCard />
          <ProxyCard />

          {formOpen ? (
            <ProviderForm
              provider={editing ?? undefined}
              onCancel={() => {
                setEditing(null)
                setCreating(false)
              }}
              onSaved={(saved) => {
                setEditing(null)
                setCreating(false)
                setExpandedId(saved.ID)
              }}
            />
          ) : providers.length === 0 ? (
            <div className="provider-list__empty">
              还没有配置服务商。点击「添加服务商」接入 OpenAI 兼容接口。
            </div>
          ) : (
            <div className="provider-list">
              {providers.map((provider) => {
                const expanded = expandedId === provider.ID
                return (
                  <section key={provider.ID} className="provider-card">
                    <header className="provider-card__head">
                      <ProviderIcon name={provider.Name} size={28} />
                      <div className="provider-card__title">
                        <div className="provider-card__name">
                          {provider.Name}
                          {provider.Enabled ? null : (
                            <span className="provider-tag provider-tag--off">已停用</span>
                          )}
                        </div>
                        <div className="provider-card__url">
                          {provider.BaseURL || '未设置 BaseURL'}
                        </div>
                      </div>
                      <Toggle
                        checked={provider.Enabled}
                        onChange={(value) => handleToggleEnabled(provider, value)}
                        label="启用"
                        disabled={busyId === provider.ID}
                      />
                      <IconButton
                        title={expanded ? '收起模型列表' : '展开模型列表'}
                        onClick={() => setExpandedId(expanded ? '' : provider.ID)}
                      >
                        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </IconButton>
                    </header>

                    <div className="provider-card__meta">
                      <span>模型 {modelCounts.get(provider.ID) ?? provider.ModelCount} 个</span>
                      {provider.LastSyncAt > 0 ? (
                        <span>
                          最近同步{' '}
                          {new Date(provider.LastSyncAt * 1000).toLocaleString('zh-CN', {
                            hour12: false,
                          })}
                        </span>
                      ) : null}
                      {provider.HasAPIKey ? <span>密钥已配置</span> : null}
                    </div>

                    {provider.LastSyncError ? (
                      <div className="provider-card__error">
                        上次同步失败：{provider.LastSyncError}
                      </div>
                    ) : null}

                    <div className="provider-card__actions">
                      <Button
                        size="sm"
                        onClick={() => handleTest(provider)}
                        loading={testingId === provider.ID}
                      >
                        测试连接
                      </Button>
                      <Button size="sm" onClick={() => setEditing(provider)}>
                        编辑
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(provider)}>
                        <Trash size={13} />
                        删除
                      </Button>
                    </div>

                    {expanded ? <ModelList providerId={provider.ID} /> : null}
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除服务商"
        description={
          deleteTarget
            ? `确定删除「${deleteTarget.Name}」？该服务商下的模型与密钥会一并移除。`
            : ''
        }
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}

/** 内置中转卡片：进页面拉一次状态；Toggle 切换 Enabled；状态行展示地址/Python/错误。 */
function RelayCard() {
  const showToast = useUiStore((s) => s.showToast)
  const [status, setStatus] = useState<RelayStatusDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    appApi
      .GetRelayStatus()
      .then((result) => {
        if (alive) setStatus(result)
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(describeError(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  async function handleToggle(enabled: boolean) {
    setBusy(true)
    try {
      setStatus(await appApi.SetRelayEnabled(enabled))
      showToast(enabled ? '内置中转已开启' : '内置中转已关闭', 'success')
    } catch (err) {
      showToast(`切换内置中转失败：${describeError(err)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="provider-card relay-card">
      <header className="provider-card__head">
        <div className="relay-card__icon">
          <Network size={18} />
        </div>
        <div className="provider-card__title">
          <div className="provider-card__name">内置中转</div>
          <div className="provider-card__url">
            内网环境下所有模型请求经由本机 Python 中转发出，默认开启
          </div>
        </div>
        <Toggle
          checked={status?.Enabled ?? false}
          onChange={(value) => void handleToggle(value)}
          label="启用"
          disabled={busy || loading || !!loadError}
        />
      </header>
      <div className="provider-card__meta relay-card__meta">
        {loading ? <span>正在获取状态…</span> : null}
        {loadError ? <span className="relay-card__error">状态获取失败：{loadError}</span> : null}
        {status ? (
          <>
            <span
              className={clsx(
                'relay-status',
                status.Running ? 'is-running' : status.Enabled ? 'is-error' : 'is-off',
              )}
            >
              <span className="relay-status__dot" aria-hidden />
              {status.Running ? '运行中' : status.Enabled ? '异常' : '未启用'}
            </span>
            {status.Running && status.Addr ? <span>{status.Addr}</span> : null}
            {status.PythonPath ? <span>Python: {status.PythonPath}</span> : null}
          </>
        ) : null}
      </div>
      {status?.Error ? <div className="provider-card__error">{status.Error}</div> : null}
    </section>
  )
}
