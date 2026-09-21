import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
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

export function Select({
  value,
  onChange,
  options,
  disabled,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <select
      className="ui-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
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
