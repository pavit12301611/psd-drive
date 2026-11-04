import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

/* --------------------------------- modal --------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 'max-w-lg',
  bare = false,
}: {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: ReactNode
  width?: string
  bare?: boolean
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    // Focus the first interactive element for keyboard users.
    const timer = setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-skip-focus])',
      )
      focusable?.focus()
    }, 30)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
      clearTimeout(timer)
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="animate-fade-in absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-pop-in relative w-full ${width} rounded-2xl border border-line bg-elevated shadow-panel`}
      >
        {bare ? (
          <button
            onClick={onClose}
            data-skip-focus
            className="absolute top-3 right-3 z-10 rounded-full bg-black/40 p-2 text-white/80 transition hover:bg-black/60 hover:text-white"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        ) : (
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              {title && <h2 className="text-base font-semibold text-body">{title}</h2>}
              {description && <p className="mt-0.5 text-xs leading-relaxed text-dim">{description}</p>}
            </div>
            <button onClick={onClose} data-skip-focus className="btn btn-ghost btn-sm -mr-1 -mt-1 p-1.5" aria-label="Close">
              <X size={16} />
            </button>
          </div>
        )}
        <div className={bare ? '' : 'px-5 py-4'}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}

/* -------------------------------- spinner -------------------------------- */

export function Spinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`animate-spin-slow inline-block rounded-full border-2 border-current border-t-transparent ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}

export function FullPageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-[50vh] flex-col items-center justify-center gap-3 text-dim">
      <Spinner size={22} />
      <p className="text-sm">{label}</p>
    </div>
  )
}

/* -------------------------------- progress ------------------------------- */

export function Progress({
  value,
  tone = 'accent',
  height = 6,
  className = '',
}: {
  value: number
  tone?: 'accent' | 'success' | 'danger' | 'muted'
  height?: number
  className?: string
}) {
  const color =
    tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : tone === 'muted' ? 'var(--border-strong)' : 'var(--accent)'
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-panel-3 ${className}`}
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
      />
    </div>
  )
}

/* --------------------------------- avatar -------------------------------- */

export function Avatar({ name, src, size = 32 }: { name: string; src?: string | null; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  if (src) {
    return <img src={src} alt={name} width={size} height={size} className="rounded-full object-cover" style={{ width: size, height: size }} />
  }

  return (
    <span
      className="brand-gradient inline-flex items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials || '?'}
    </span>
  )
}

/* ---------------------------------- bits --------------------------------- */

export function Chip({
  children,
  tone = 'muted',
  className = '',
}: {
  children: ReactNode
  tone?: 'muted' | 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const styles: Record<string, string> = {
    muted: 'bg-panel-3 text-dim',
    accent: 'bg-accent-soft text-accent',
    success: '',
    warning: '',
    danger: '',
  }
  const inline =
    tone === 'success'
      ? { background: 'color-mix(in srgb, var(--success) 14%, transparent)', color: 'var(--success)' }
      : tone === 'warning'
        ? { background: 'color-mix(in srgb, var(--warning) 16%, transparent)', color: 'var(--warning)' }
        : tone === 'danger'
          ? { background: 'var(--danger-soft)', color: 'var(--danger)' }
          : undefined

  return (
    <span className={`chip ${styles[tone]} ${className}`} style={inline}>
      {children}
    </span>
  )
}

export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-faint">{hint}</span>}
    </label>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-panel-2 text-dim">{icon}</div>
      <h3 className="text-sm font-semibold text-body">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-dim">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[11px] font-semibold tracking-[0.09em] text-faint uppercase">{children}</h2>
      {action}
    </div>
  )
}

/** Confirm-then-run dialog used for destructive actions. */
export function ConfirmButton({
  label,
  confirmLabel = 'Confirm',
  title,
  description,
  onConfirm,
  className = 'btn btn-danger',
  disabled,
}: {
  label: ReactNode
  confirmLabel?: string
  title: string
  description?: string
  onConfirm: () => void | Promise<void>
  className?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} description={description} width="max-w-md">
        <div className="flex justify-end gap-2">
          <button className="btn btn-outline" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                setOpen(false)
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner size={14} /> : null}
            {confirmLabel}
          </button>
        </div>
      </Modal>
    </>
  )
}
