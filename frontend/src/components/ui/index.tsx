import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import clsx from 'clsx'
import { useUiStore } from '../../app/uiStore'
import './ui.css'

/* 本项目最小的 UI primitive 集合。所有页面与 feature 只允许使用这里的组件，
   样式由 ui.css + styles/tokens.css 提供，禁止在 feature 内复制一套按钮/弹窗。 */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  disabled?: boolean
  loading?: boolean
  title?: string
  type?: 'button' | 'submit'
  className?: string
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  loading,
  title,
  type = 'button',
  className,
}: ButtonProps) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={clsx('ui-btn', `ui-btn--${variant}`, size === 'sm' && 'ui-btn--sm', className)}
    >
      {loading ? <span className="ui-btn__spinner" /> : null}
      <span className="ui-btn__label">{children}</span>
    </button>
  )
}

export interface IconButtonProps {
  children: ReactNode
  onClick?: () => void
  title: string
  disabled?: boolean
  active?: boolean
  className?: string
}

export function IconButton({ children, onClick, title, disabled, active, className }: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={clsx('ui-icon-btn', active && 'is-active', className)}
    >
      {children}
    </button>
  )
}

export interface InputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'number'
  disabled?: boolean
  autoFocus?: boolean
  required?: boolean
  onEnter?: () => void
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  autoFocus,
  required,
  onEnter,
}: InputProps) {
  return (
    <input
      className="ui-input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) {
          e.preventDefault()
          onEnter()
        }
      }}
    />
  )
}

export interface TextareaProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
  className,
  style,
  onKeyDown,
  onPaste,
}: TextareaProps) {
  return (
    <textarea
      className={clsx('ui-textarea', className)}
      style={style}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </label>
  )
}

export interface SelectOption {
  value: string
  label: string
}

export interface SelectGroup {
  label: string
  options: SelectOption[]
}

/* 自绘下拉（替代原生 <select>）：触发钮外观同输入框，弹层磨砂玻璃、向下展开，
   下方空间不足时自动向上；点击外部 / Esc 关闭并把焦点还给触发钮。
   options 与 groups 二选一；groups 会渲染小字组头，空组不渲染。 */
export function Select({
  value,
  onChange,
  options,
  groups,
  disabled,
  placeholder,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  groups?: SelectGroup[]
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [openUp, setOpenUp] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const sections: SelectGroup[] = groups
    ? groups.filter((group) => group.options.length > 0)
    : [{ label: '', options: options ?? [] }]
  const selected = sections.flatMap((s) => s.options).find((option) => option.value === value)

  /* 打开期间挂全局监听：点击组件外或按 Esc 关闭；被禁用（如提交中）时立即收起。 */
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

  const toggle = () => {
    if (!open && triggerRef.current) {
      // 下方放不下弹层（≈260px + 6px 间隙）且上方更宽敞时改为向上展开
      const rect = triggerRef.current.getBoundingClientRect()
      const below = window.innerHeight - rect.bottom
      setOpenUp(below < 266 && rect.top > below)
    }
    setOpen((prev) => !prev)
  }

  const pick = (next: string) => {
    setOpen(false)
    triggerRef.current?.focus()
    if (next !== value) onChange(next)
  }

  return (
    <div className={clsx('ui-select', className)} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={clsx('ui-select__trigger', open && 'is-open')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.label ?? placeholder}
        onClick={toggle}
      >
        <span className={clsx('ui-select__label', !selected && 'ui-select__placeholder')}>
          {selected?.label ?? placeholder ?? ''}
        </span>
        <ChevronDown size={14} className="ui-select__chevron" />
      </button>
      {open ? (
        <div className={clsx('ui-select__pop scroll-area', openUp && 'is-up')} role="listbox">
          {sections.map((section, index) => (
            <Fragment key={section.label || index}>
              {section.label ? <div className="ui-select__group-name">{section.label}</div> : null}
              {section.options.map((option) => {
                const isSelected = option.value === value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={clsx('ui-select__item', isSelected && 'is-selected')}
                    onClick={() => pick(option.value)}
                  >
                    <span className="ui-select__item-label">{option.label}</span>
                    {isSelected ? <Check size={14} className="ui-select__check" /> : null}
                  </button>
                )
              })}
            </Fragment>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={clsx('ui-toggle', checked && 'is-on')}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle__knob" />
      {label ? <span className="ui-toggle__label">{label}</span> : null}
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="ui-spinner" style={{ width: size, height: size }} />
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="ui-empty">
      {icon ? <div className="ui-empty__icon">{icon}</div> : null}
      <div className="ui-empty__title">{title}</div>
      {description ? <div className="ui-empty__desc">{description}</div> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="ui-mask" onMouseDown={onClose}>
      <div
        className="ui-modal"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ui-modal__head">
          <h2>{title}</h2>
          <IconButton title="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="ui-modal__body">{children}</div>
        {footer ? <footer className="ui-modal__foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width = 560,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="ui-mask ui-mask--right" onMouseDown={onClose}>
      <aside
        className="ui-drawer"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ui-drawer__head">
          <h2>{title}</h2>
          <IconButton title="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="ui-drawer__body">{children}</div>
        {footer ? <footer className="ui-drawer__foot">{footer}</footer> : null}
      </aside>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = '删除',
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  description?: string
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="ui-confirm__desc">{description ?? '该操作不可撤销。'}</p>
    </Modal>
  )
}

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts)
  const dismiss = useUiStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="ui-toasts">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx('ui-toast', `ui-toast--${toast.kind}`)}
          onClick={() => dismiss(toast.id)}
        >
          {toast.text}
        </div>
      ))}
    </div>
  )
}
