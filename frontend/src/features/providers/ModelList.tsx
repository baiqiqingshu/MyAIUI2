import { useMemo, useState } from 'react'
import { Plus, Trash } from 'lucide-react'
import { Button, ConfirmDialog, IconButton, Input, Select, Toggle } from '../../components/ui'
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
  const [deleteTarget, setDeleteTarget] = useState<ModelDTO | null>(null)
  // 本次同步新增的模型 ID；非空时在列表上方显示勾选面板（默认全不选）。
  const [addedIDs, setAddedIDs] = useState<string[]>([])
  const [selectedIDs, setSelectedIDs] = useState<string[]>([])
  const [enabling, setEnabling] = useState(false)

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

  async function handleDelete() {
    const target = deleteTarget
    if (!target) return
    try {
      await appApi.DeleteModel(target.ID)
      await refreshModels()
      showToast('模型已删除', 'success')
    } catch (error) {
      showToast(`删除失败：${describeError(error)}`, 'error')
    } finally {
      setDeleteTarget(null)
    }
  }

  return (
    <div className="model-list">
      <div className="model-list__toolbar">
        <span className="model-list__count">共 {models.length} 个模型</span>
        <div className="model-list__actions">
          <Button size="sm" onClick={handleSync} loading={syncing}>
            同步模型
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding((v) => !v)}>
            <Plus size={13} />
            手动添加模型
          </Button>
        </div>
      </div>

      {adding ? (
        <div className="model-list__add">
          <Input value={newRemoteID} onChange={setNewRemoteID} placeholder="模型 ID（如 gpt-4o-mini）" />
          <Input value={newDisplayName} onChange={setNewDisplayName} placeholder="显示名称（可留空）" />
          <Select value={newModality} onChange={setNewModality} options={MODALITY_OPTIONS} />
          <Button size="sm" variant="primary" onClick={handleAdd} loading={busyId === 'new'}>
            添加
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
      ) : (
        <ul className="model-list__items">
          {models.map((model) => (
            <li key={model.ID} className="model-row">
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
              <IconButton title="删除模型" onClick={() => setDeleteTarget(model)}>
                <Trash size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除模型"
        description={deleteTarget ? `确定删除模型「${deleteTarget.DisplayName}」？` : ''}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
