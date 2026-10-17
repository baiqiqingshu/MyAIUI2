import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Eraser, Plus, Trash } from 'lucide-react'
import { Button, IconButton, Input, Select, Toggle } from '../../components/ui'
import { appApi } from '../../bridge/appApi'
import { useUiStore } from '../../app/uiStore'
import type { ModelDTO } from '../../domain/dto'
import { describeError } from './errors'
import { syncModels } from './modelSync'

const MODALITY_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图片' },
]

// 单个服务商的模型列表：同步、手动添加、modality 修正、启停与删除。
export function ModelList({ providerId }: { providerId: string }) {
  const allModels = useUiStore((s) => s.models)
  const refreshModels = useUiStore((s) => s.refreshModels)
  const showToast = useUiStore((s) => s.showToast)

  const models = useMemo(
    () => allModels.filter((m) => m.ProviderID === providerId),
    [allModels, providerId],
  )

  const [syncing, setSyncing] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [adding, setAdding] = useState(false)
  const [newRemoteID, setNewRemoteID] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newModality, setNewModality] = useState('text')
  const [purging, setPurging] = useState(false)
  // 本次同步新增的模型 ID；非空时在列表上方显示勾选面板（默认全不选）。
  const [addedIDs, setAddedIDs] = useState<string[]>([])
  const [selectedIDs, setSelectedIDs] = useState<string[]>([])
  const [enabling, setEnabling] = useState(false)
  // 检索与批量勾选：过滤只影响显示，不丢勾选（局部状态，不进 store）。
  const [query, setQuery] = useState('')
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(new Set())
  const [batchAction, setBatchAction] = useState<'' | 'enable' | 'disable'>('')

  // 「已失联」模型数：> 0 时「清理失效模型」可点。
  const missingCount = useMemo(() => models.filter((m) => m.MissingRemote).length, [models])

  // 检索：按 DisplayName/RemoteID 包含匹配（大小写不敏感），只影响显示不丢勾选。
  const filtering = query.trim() !== ''
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return models
    return models.filter(
      (m) => m.DisplayName.toLowerCase().includes(q) || m.RemoteID.toLowerCase().includes(q),
    )
  }, [models, query])

  // 勾选集中属于本服务商且仍存活的模型（计数与批量操作都以它为准）。
  const checkedModelIds = useMemo(
    () => models.filter((m) => checkedIds.has(m.ID)).map((m) => m.ID),
    [models, checkedIds],
  )
  const allFilteredChecked =
    filteredModels.length > 0 && filteredModels.every((m) => checkedIds.has(m.ID))

  // 面板内容始终按 ID 从 store 取，刷新后展示信息保持最新。
  const addedModels = useMemo(
    () => addedIDs.map((id) => allModels.find((m) => m.ID === id)).filter((m): m is ModelDTO => !!m),
    [addedIDs, allModels],
  )

  function closeAddedPanel() {
    setAddedIDs([])
    setSelectedIDs([])
  }

  function toggleSelected(id: string) {
    setSelectedIDs((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]))
  }

  function toggleChecked(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 「全选/清空」：勾上当前筛选出的全部模型；筛选结果已全勾时清空整个勾选集。 */
  function handleSelectAllToggle() {
    setCheckedIds((prev) => {
      if (filteredModels.length > 0 && filteredModels.every((m) => prev.has(m.ID))) {
        return new Set<string>()
      }
      const next = new Set(prev)
      for (const m of filteredModels) next.add(m.ID)
      return next
    })
  }

  // 批量启停：逐个 SetModelEnabled，部分失败时报告成功/失败数并保留勾选便于重试。
  async function handleBatchSetEnabled(enabled: boolean) {
    const ids = checkedModelIds
    if (ids.length === 0) return
    setBatchAction(enabled ? 'enable' : 'disable')
    try {
      const results = await Promise.allSettled(
        ids.map((id) => appApi.SetModelEnabled(id, enabled)),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      await refreshModels()
      const verb = enabled ? '启用' : '停用'
      if (failed > 0) {
        showToast(`已${verb} ${ids.length - failed} 个模型，${failed} 个失败`, 'error')
      } else {
        showToast(`已${verb} ${ids.length} 个模型`, 'success')
      }
    } finally {
      setBatchAction('')
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await syncModels(providerId)
      if (result && result.AddedIDs.length > 0) {
        setAddedIDs(result.AddedIDs)
        setSelectedIDs([])
      }
    } finally {
      setSyncing(false)
    }
  }

  async function handleEnableSelected() {
    const targetIDs = selectedIDs
    if (targetIDs.length === 0) return
    setEnabling(true)
    try {
      await Promise.all(targetIDs.map((id) => appApi.SetModelEnabled(id, true)))
      await refreshModels()
      closeAddedPanel()
      showToast(`已启用 ${targetIDs.length} 个模型`, 'success')
    } catch (error) {
      showToast(`启用失败：${describeError(error)}`, 'error')
    } finally {
      setEnabling(false)
    }
  }

  async function handleToggle(model: ModelDTO, enabled: boolean) {
    setBusyId(model.ID)
    try {
      await appApi.SetModelEnabled(model.ID, enabled)
      await refreshModels()
    } catch (error) {
      showToast(`操作失败：${describeError(error)}`, 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handleModality(model: ModelDTO, modality: string) {
    if (modality === model.Modality) return
    setBusyId(model.ID)
    try {
      await appApi.SaveManualModel({
        ID: model.ID,
        ProviderID: model.ProviderID,
        RemoteID: model.RemoteID,
        DisplayName: model.DisplayName,
        Modality: modality,
      })
      await refreshModels()
      showToast('模型类型已更新', 'success')
    } catch (error) {
      showToast(`修改失败：${describeError(error)}`, 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handleAdd() {
    const remoteID = newRemoteID.trim()
    if (!remoteID) {
      showToast('请填写模型 ID', 'error')
      return
    }
    setBusyId('new')
    try {
      await appApi.SaveManualModel({
        ID: '',
        ProviderID: providerId,
        RemoteID: remoteID,
        DisplayName: newDisplayName.trim() || remoteID,
        Modality: newModality,
      })
      setNewRemoteID('')
      setNewDisplayName('')
      setNewModality('text')
      setAdding(false)
      await refreshModels()
      showToast('模型已添加', 'success')
    } catch (error) {
      showToast(`添加失败：${describeError(error)}`, 'error')
    } finally {
      setBusyId('')
    }
  }

  function handleCancelAdd() {
    setAdding(false)
    setNewRemoteID('')
    setNewDisplayName('')
    setNewModality('text')
  }

  // 删除模型不弹确认：误删可通过「同步模型」找回远端模型。
  async function handleDelete(model: ModelDTO) {
    setBusyId(model.ID)
    try {
      await appApi.DeleteModel(model.ID)
      await refreshModels()
      showToast('模型已删除', 'success')
    } catch (error) {
      showToast(`删除失败：${describeError(error)}`, 'error')
    } finally {
      setBusyId('')
    }
  }

  async function handlePurge() {
    setPurging(true)
    try {
      const removed = await appApi.PurgeMissingModels(providerId)
      await refreshModels()
      showToast(`已清理 ${removed} 个失效模型`, 'success')
    } catch (error) {
      showToast(`清理失败：${describeError(error)}`, 'error')
    } finally {
      setPurging(false)
    }
  }

  return (
    <div className="model-list">
      <div className="model-list__toolbar">
        <span className="model-list__count">
          {filtering ? `共 ${filteredModels.length}/${models.length} 个模型` : `共 ${models.length} 个模型`}
          {checkedModelIds.length > 0 ? ` · 已选 ${checkedModelIds.length}` : ''}
        </span>
        <div className="model-list__search">
          <Input value={query} onChange={setQuery} placeholder="搜索模型名或 ID" />
        </div>
        <div className="model-list__actions">
          <Button size="sm" onClick={handleSync} loading={syncing}>
            同步模型
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handlePurge}
            loading={purging}
            disabled={missingCount === 0}
            title="删除远端已不存在的模型"
          >
            <Eraser size={13} />
            清理失效模型{missingCount > 0 ? `（${missingCount}）` : ''}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
            <Plus size={13} />
            手动添加模型
          </Button>
        </div>
      </div>

      {/* 批量启停条：「全选」作用于当前筛选结果；过滤不丢勾选 */}
      <div className="model-list__batch">
        <Button
          size="sm"
          variant="ghost"
          onClick={handleSelectAllToggle}
          disabled={batchAction !== '' || filteredModels.length === 0}
        >
          {allFilteredChecked ? '清空' : '全选'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleBatchSetEnabled(true)}
          loading={batchAction === 'enable'}
          disabled={checkedModelIds.length === 0 || batchAction !== ''}
        >
          启用所选{checkedModelIds.length > 0 ? `（${checkedModelIds.length}）` : ''}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void handleBatchSetEnabled(false)}
          loading={batchAction === 'disable'}
          disabled={checkedModelIds.length === 0 || batchAction !== ''}
        >
          停用所选
        </Button>
      </div>

      {adding ? (
        <div className="model-list__add">
          <Input value={newRemoteID} onChange={setNewRemoteID} placeholder="模型 ID（如 gpt-4o-mini）" />
          <Input value={newDisplayName} onChange={setNewDisplayName} placeholder="显示名称（可留空）" />
          <Select value={newModality} onChange={setNewModality} options={MODALITY_OPTIONS} />
          <Button size="sm" variant="primary" onClick={handleAdd} loading={busyId === 'new'}>
            添加
          </Button>
          <Button size="sm" variant="ghost" onClick={handleCancelAdd} disabled={busyId === 'new'}>
            取消
          </Button>
        </div>
      ) : null}

      {addedModels.length > 0 ? (
        <div className="model-sync-panel">
          <div className="model-sync-panel__head">
            <span className="model-sync-panel__title">本次新增 {addedModels.length} 个模型</span>
            <span className="model-sync-panel__hint">新同步的模型默认未启用，请勾选要使用的模型</span>
          </div>
          <ul className="model-sync-panel__items">
            {addedModels.map((model) => (
              <li key={model.ID}>
                <label className="model-sync-panel__label">
                  <input
                    type="checkbox"
                    checked={selectedIDs.includes(model.ID)}
                    disabled={enabling}
                    onChange={() => toggleSelected(model.ID)}
                  />
                  <span className="model-sync-panel__name">{model.DisplayName}</span>
                  <span className="model-sync-panel__remote">{model.RemoteID}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="model-sync-panel__actions">
            <Button
              size="sm"
              variant="ghost"
              disabled={enabling}
              onClick={() =>
                setSelectedIDs(
                  selectedIDs.length === addedModels.length ? [] : addedModels.map((m) => m.ID),
                )
              }
            >
              {selectedIDs.length === addedModels.length ? '取消全选' : '全选'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={enabling}
              disabled={selectedIDs.length === 0}
              onClick={handleEnableSelected}
            >
              启用选中（{selectedIDs.length}）
            </Button>
            <Button size="sm" variant="ghost" disabled={enabling} onClick={closeAddedPanel}>
              跳过
            </Button>
          </div>
        </div>
      ) : null}

      {models.length === 0 ? (
        <div className="model-list__empty">暂无模型，点击「同步模型」从服务商拉取。</div>
      ) : filteredModels.length === 0 ? (
        <div className="model-list__empty">没有匹配「{query.trim()}」的模型。</div>
      ) : (
        <ul className="model-list__items">
          {filteredModels.map((model) => (
            <li
              key={model.ID}
              className={clsx('model-row', checkedIds.has(model.ID) && 'is-checked')}
            >
              <input
                type="checkbox"
                className="model-row__check"
                checked={checkedIds.has(model.ID)}
                disabled={batchAction !== ''}
                aria-label={`选择模型 ${model.DisplayName}`}
                onChange={() => toggleChecked(model.ID)}
              />
              <div className="model-row__main">
                <div className="model-row__name">{model.DisplayName}</div>
                <div className="model-row__remote">{model.RemoteID}</div>
              </div>
              <div className="model-row__tags">
                {model.Source === 'manual' ? <span className="model-tag">手动</span> : null}
                {model.MissingRemote ? <span className="model-tag model-tag--warn">已失联</span> : null}
              </div>
              <Select
                value={model.Modality}
                onChange={(value) => handleModality(model, value)}
                options={MODALITY_OPTIONS}
                disabled={busyId === model.ID}
              />
              <Toggle
                checked={model.Enabled}
                onChange={(value) => handleToggle(model, value)}
                label="启用"
                disabled={busyId === model.ID}
              />
              <IconButton
                title="删除模型"
                onClick={() => void handleDelete(model)}
                disabled={busyId === model.ID}
              >
                <Trash size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
