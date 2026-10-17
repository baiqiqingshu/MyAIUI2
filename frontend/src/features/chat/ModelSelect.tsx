import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import type { ModelDTO, ProviderDTO } from '../../domain/dto'

export interface ModelSelectProps {
  /** 可选模型列表（selectUsableModels 结果），弹层内按服务商分组 */
  models: ModelDTO[]
  /** 全部服务商：决定分组顺序与组头名称 */
  providers: ProviderDTO[]
  /** 当前选中的模型 ID；'' 表示未选择 */
  value: string
  onChange: (modelId: string) => void
  disabled?: boolean
  placeholder?: string
}

/* 模型选择下拉（替代原生 <select>）：触发按钮显示「服务商 / 模型名」，
   弹层向上展开、按服务商分组，每项 DisplayName + RemoteID 两行。
   点击外部 / Esc 关闭；焦点在触发按钮上时 Enter/Space 走原生 click 开合。 */
export function ModelSelect({
  models,
  providers,
  value,
  onChange,
  disabled,
  placeholder,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const providerName = (id: string) => providers.find((p) => p.ID === id)?.Name ?? '未知服务'
  const current = models.find((m) => m.ID === value)
  const label = current ? `${providerName(current.ProviderID)} / ${current.DisplayName}` : ''

  // 按 providers 顺序分组；没有可用模型的服务商不产出分组。
  const groups = providers
    .map((provider) => ({ provider, items: models.filter((m) => m.ProviderID === provider.ID) }))
    .filter((group) => group.items.length > 0)

  /* 打开期间挂全局监听：点击组件外或按 Esc 关闭；被禁用（如开始生成）时立即收起。 */
  useEffect(() => {
    if (!open) return
    if (disabled) {
      setOpen(false)
      return
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // 焦点在弹层内时 Esc 关闭后还回触发按钮，避免焦点掉到 body
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, disabled])

  const pick = (modelId: string) => {
    setOpen(false)
    triggerRef.current?.focus()
    if (modelId !== value) onChange(modelId)
  }

  return (
    <div className="model-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx('model-select__trigger', open && 'is-open')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label || placeholder}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={clsx('model-select__label', !current && 'is-placeholder')}>
          {label || placeholder || '选择模型'}
        </span>
        <ChevronDown size={13} className="model-select__chevron" />
      </button>
      {open ? (
        <div className="model-select__pop scroll-area" role="listbox" aria-label="选择模型">
          {groups.map((group) => (
            <div key={group.provider.ID} className="model-select__group">
              <div className="model-select__group-name">{group.provider.Name}</div>
              {group.items.map((model) => {
                const selected = model.ID === value
                return (
                  <button
                    key={model.ID}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={clsx('model-select__item', selected && 'is-selected')}
                    onClick={() => pick(model.ID)}
                  >
                    <span className="model-select__item-text">
                      <span className="model-select__item-name">{model.DisplayName}</span>
                      <span className="model-select__item-remote">{model.RemoteID}</span>
                    </span>
                    {selected ? <Check size={14} className="model-select__item-check" /> : null}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
