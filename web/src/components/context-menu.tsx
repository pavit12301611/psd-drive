import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | {
      label: string
      icon?: ReactNode
      onClick: () => void
      danger?: boolean
      disabled?: boolean
      separatorBefore?: boolean
      shortcut?: string
    }
  | { separator: true }

/** Right-click / overflow menu anchored to the pointer, kept inside the viewport. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const left = Math.min(x, window.innerWidth - rect.width - 8)
    const top = Math.min(y, window.innerHeight - rect.height - 8)
    setPosition({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [x, y])

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="animate-pop-in fixed z-[70] min-w-[196px] overflow-hidden rounded-xl border border-line bg-elevated p-1 shadow-panel"
      style={{ left: position.left, top: position.top }}
    >
      {items.map((item, index) => {
        if ('separator' in item) {
          return <div key={`sep-${index}`} className="my-1 h-px bg-[var(--border)]" />
        }
        return (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
              item.danger ? 'text-danger hover:bg-[var(--danger-soft)]' : 'text-dim hover:bg-panel-2 hover:text-body'
            }`}
          >
            <span className="w-4 shrink-0">{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <span className="text-[10px] text-faint">{item.shortcut}</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
