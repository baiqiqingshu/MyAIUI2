import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { appApi } from '../../bridge/appApi'
import type { ModelDTO, SaveAssistantDTO } from '../../domain/dto'
import { selectUsableModels, useUiStore } from '../../app/uiStore'
import { Button, ConfirmDialog, Drawer, Field, Input, Select, Textarea, Toggle } from '../../components/ui'
import {
  AssistantAvatar,
  ASSISTANT_AVATAR_COLORS,
  ASSISTANT_AVATAR_ICONS,
  assistantAvatarSpec,
  AVATAR_FALLBACK_SPEC,
  parseAssistantAvatar,
} from '../../components/icons/AssistantAvatar'
import './assistants.css'

const EMOJI_FALLBACK = AVATAR_FALLBACK_SPEC
// 助手头像精选集：挑渲染美观、不俗气的款
const EMOJI_CHOICES = [
  '🔮',
  '✨',
  '💡',
  '🎯',
  '🚀',
  '⚡',
  '🦉',
  '🐱',
  '🦊',
  '🐼',
  '🐨',
  '🦄',
  '🌙',
  '🌸',
  '🍀',
  '🔥',
  '💎',
  '🎨',
  '📚',
  '🧠',
  '💫',
  '🌊',
  '🍵',
  '🐧',
]
const TEMPERATURE_DEFAULT = 0.7

interface ModelGroup {
  providerId: string
  providerName: string
  models: ModelDTO[]
}

/** 新建/编辑助手抽屉：仅在 drawer.kind==='assistant' 时挂载表单。 */
export function AssistantEditor() {
  const drawer = useUiStore((s) => s.drawer)
  if (drawer.kind !== 'assistant') return null
  // key 让每次打开都重新初始化表单（关闭即卸载），避免残留上次输入。
  return <AssistantForm key={drawer.assistantId || 'new'} assistantId={drawer.assistantId} />
}

function AssistantForm({ assistantId }: { assistantId: string }) {
  const assistants = useUiStore((s) => s.assistants)
  const models = useUiStore((s) => s.models)
  const providers = useUiStore((s) => s.providers)
  const closeDrawer = useUiStore((s) => s.closeDrawer)
  const refreshAssistants = useUiStore((s) => s.refreshAssistants)
  const showToast = useUiStore((s) => s.showToast)

  const current = assistantId ? assistants.find((a) => a.ID === assistantId) : undefined

  const [name, setName] = useState(current?.Name ?? '')
  const [emoji, setEmoji] = useState(current?.Emoji || EMOJI_FALLBACK)
  const [systemPrompt, setSystemPrompt] = useState(current?.SystemPrompt ?? '')
  const [modelId, setModelId] = useState(current?.ModelID ?? '')
  const [temperature, setTemperature] = useState(
    current?.TemperatureSet ? current.Temperature : TEMPERATURE_DEFAULT,
  )
  const [temperatureSet, setTemperatureSet] = useState(current?.TemperatureSet ?? false)
  const [webSearchDefault, setWebSearchDefault] = useState(current?.WebSearchDefault ?? false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 仅可用模型（自身启用 + 所属服务商启用），按服务商名分组（组内按显示名排序）。
  const modelGroups = useMemo<ModelGroup[]>(() => {
    const grouped = new Map<string, ModelDTO[]>()
    for (const model of selectUsableModels(models, providers)) {
      const list = grouped.get(model.ProviderID)
      if (list) list.push(model)
      else grouped.set(model.ProviderID, [model])
    }
    return [...grouped.entries()]
      .map(([providerId, list]) => ({
        providerId,
        providerName: providers.find((p) => p.ID === providerId)?.Name || '未知服务商',
        models: [...list].sort((a, b) =>
          (a.DisplayName || a.RemoteID).localeCompare(b.DisplayName || b.RemoteID, 'zh-Hans-CN'),
        ),
      }))
      .sort((a, b) => a.providerName.localeCompare(b.providerName, 'zh-Hans-CN'))
  }, [models, providers])

  const usableCount = modelGroups.reduce((total, group) => total + group.models.length, 0)

  // 头像状态：emoji 字段可能是 icon:<名>:<色> 规格、纯 emoji 或空（空走内置兜底）。
  const avatarParsed = parseAssistantAvatar(emoji)
  const iconKey = avatarParsed.kind === 'icon' ? avatarParsed.icon.key : ''
  const colorKey = avatarParsed.kind === 'icon' ? avatarParsed.color.key : 'indigo'
  const colorBg =
    ASSISTANT_AVATAR_COLORS.find((c) => c.key === colorKey)?.bg ?? ASSISTANT_AVATAR_COLORS[0].bg

  // 自绘 Select 的分组数据：「未选择」作为空 label 组排最前（空组头不渲染标题），
  // 选中它后 modelId 回到 ''，保存仍走原来的留空逻辑。
  const selectGroups = useMemo(
    () => [
      { label: '', options: [{ value: '', label: '未选择' }] },
      ...modelGroups.map((group) => ({
        label: group.providerName,
        options: group.models.map((model) => ({
          value: model.ID,
          label: model.DisplayName || model.RemoteID,
        })),
      })),
    ],
    [modelGroups],
  )

  async function handleSave() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      showToast('请填写助手名称', 'error')
      return
    }
    // 这里用全量 models 解析：服务商临时停用时保留原有绑定（重新启用后即可继续用），
    // 只有模型已删除时才会清空，避免 ModelID 与 ProviderID 不一致。
    const model = modelId ? models.find((m) => m.ID === modelId) : undefined
    const input: SaveAssistantDTO = {
      ID: assistantId,
      Name: trimmedName,
      Emoji: emoji.trim() || EMOJI_FALLBACK,
      SystemPrompt: systemPrompt,
      ProviderID: model?.ProviderID ?? '',
      ModelID: model?.ID ?? '',
      Temperature: temperature,
      TemperatureSet: temperatureSet,
      WebSearchDefault: webSearchDefault,
    }
    setSaving(true)
    try {
      const saved = await appApi.SaveAssistant(input)
      await refreshAssistants(saved.ID)
      closeDrawer()
      showToast(assistantId ? '助手已更新' : '助手已创建', 'success')
    } catch (err) {
      showToast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setConfirmDelete(false)
    setSaving(true)
    try {
      await appApi.DeleteAssistant(assistantId)
      await refreshAssistants()
      closeDrawer()
      showToast('助手已删除', 'success')
    } catch (err) {
      showToast(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Drawer
        open
        title={assistantId ? '编辑助手' : '新建助手'}
        onClose={closeDrawer}
        footer={
          <>
            {assistantId ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={saving}>
                删除助手
              </Button>
            ) : null}
            <span className="as-edit__spacer" />
            <Button onClick={closeDrawer} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" onClick={handleSave} loading={saving}>
              保存
            </Button>
          </>
        }
      >
        <Field label="头像" hint="图标 + 配色；也可以直接用 Emoji">
          <div className="as-emoji">
            <div className="as-emoji__preview">
              <AssistantAvatar value={emoji} size={44} />
            </div>
            <div className="as-avatar">
              <div className="as-avatar__label">图标</div>
              <div className="as-emoji__grid" role="group" aria-label="选择图标">
                {ASSISTANT_AVATAR_ICONS.map(({ key, label, Icon }) => {
                  const selected = iconKey === key
                  return (
                    <button
                      key={key}
                      type="button"
                      className={clsx('as-emoji__opt', 'as-avatar__opt', selected && 'is-selected')}
                      style={selected ? { background: colorBg, color: '#fff' } : undefined}
                      title={label}
                      aria-label={`图标：${label}`}
                      aria-pressed={selected}
                      onClick={() => setEmoji(assistantAvatarSpec(key, colorKey))}
                    >
                      <Icon size={16} strokeWidth={2.2} />
                    </button>
                  )
                })}
              </div>
              <div className="as-avatar__label">配色</div>
              <div className="as-avatar__colors" role="group" aria-label="选择配色">
                {ASSISTANT_AVATAR_COLORS.map((color) => {
                  const selected = avatarParsed.kind === 'icon' && avatarParsed.color.key === color.key
                  return (
                    <button
                      key={color.key}
                      type="button"
                      className={clsx('as-avatar__swatch', selected && 'is-selected')}
                      style={{ background: color.bg }}
                      title={color.label}
                      aria-label={`配色：${color.label}`}
                      aria-pressed={selected}
                      onClick={() => setEmoji(assistantAvatarSpec(iconKey || 'sparkles', color.key))}
                    />
                  )
                })}
              </div>
              <div className="as-avatar__label">Emoji</div>
              <div className="as-emoji__grid" role="group" aria-label="选择 Emoji">
                {EMOJI_CHOICES.map((choice) => {
                  const selected = avatarParsed.kind === 'emoji' && emoji === choice
                  return (
                    <button
                      key={choice}
                      type="button"
                      className={clsx('as-emoji__opt', selected && 'is-selected')}
                      title={choice}
                      aria-label={`选择 ${choice}`}
                      aria-pressed={selected}
                      onClick={() => setEmoji(choice)}
                    >
                      {choice}
                    </button>
                  )
                })}
                <input
                  className="as-emoji__custom"
                  value={
                    avatarParsed.kind === 'emoji' && !EMOJI_CHOICES.includes(emoji) ? emoji : ''
                  }
                  placeholder="…"
                  title="自定义 Emoji"
                  aria-label="自定义 Emoji"
                  onChange={(event) => {
                    // 自定义输入只取末位字符（码点级），防止一次塞入多个字符
                    const last = [...event.target.value].pop()
                    if (last && last.trim()) setEmoji(last)
                  }}
                />
              </div>
            </div>
          </div>
        </Field>

        <Field label="名称">
          <Input value={name} onChange={setName} placeholder="例如：代码助手" autoFocus />
        </Field>

        <Field label="系统提示词" hint="用于设定助手的角色与回答风格">
          <Textarea
            value={systemPrompt}
            onChange={setSystemPrompt}
            rows={8}
            placeholder="例如：你是一名严谨的中文技术助手，回答尽量简洁。"
          />
        </Field>

        <Field
          label="默认模型"
          hint={
            usableCount > 0
              ? '仅列出可用模型（模型与其所属模型服务都处于启用状态）；留空表示由对话页选择'
              : '暂无可用模型：请先在「模型服务」中启用服务商并勾选模型'
          }
        >
          <Select
            value={modelId}
            onChange={setModelId}
            placeholder="未选择"
            groups={selectGroups}
          />
        </Field>

        <Field
          label="温度"
          hint={temperatureSet ? '已覆盖模型默认采样温度' : '未启用时使用模型默认温度'}
        >
          <div className="as-edit__temp">
            <Toggle
              checked={temperatureSet}
              onChange={setTemperatureSet}
              label={temperatureSet ? temperature.toFixed(1) : '默认'}
            />
            <input
              type="range"
              className="as-edit__range"
              min={0}
              max={2}
              step={0.1}
              value={temperature}
              disabled={!temperatureSet}
              onChange={(event) => setTemperature(Number(event.target.value))}
            />
          </div>
        </Field>

        <Field label="默认联网" hint="新建对话时是否默认开启联网搜索">
          <Toggle
            checked={webSearchDefault}
            onChange={setWebSearchDefault}
            label={webSearchDefault ? '开启' : '关闭'}
          />
        </Field>
      </Drawer>

      <ConfirmDialog
        open={confirmDelete}
        title="删除助手"
        description="删除后该助手及其全部话题、消息都会被移除，且不可撤销。"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  )
}
