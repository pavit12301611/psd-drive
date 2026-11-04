import { useEffect, useRef, useState } from 'react'
import { KeyRound, LogOut, Menu, Moon, Search, Settings, Sun, Upload, X } from 'lucide-react'
import { useAuth, useTheme } from '../lib/app-context'
import { Link, navigate } from '../lib/router'
import { Avatar } from './ui'

export function Topbar({
  query,
  onQueryChange,
  onMenuClick,
  onUploadClick,
}: {
  query?: string
  onQueryChange?: (value: string) => void
  onMenuClick?: () => void
  onUploadClick?: () => void
}) {
  const { user, signOut } = useAuth()
  const { theme, toggle } = useTheme()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-panel/85 px-3 backdrop-blur-md sm:px-4">
      <button className="btn btn-ghost p-2 lg:hidden" onClick={onMenuClick} aria-label="Open menu">
        <Menu size={18} />
      </button>

      <div className="relative min-w-0 flex-1 sm:max-w-md">
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
        <input
          ref={searchRef}
          value={query ?? ''}
          onChange={(event) => onQueryChange?.(event.target.value)}
          placeholder="Search files…"
          className="input py-2 pl-9 text-[13px]"
          aria-label="Search files"
        />
        {query ? (
          <button
            onClick={() => onQueryChange?.('')}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-faint hover:text-body"
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[10px] text-faint sm:block">
            ⌘K
          </kbd>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1">
        <button className="btn btn-primary hidden sm:inline-flex" onClick={onUploadClick}>
          <Upload size={15} />
          Upload
        </button>
        <button
          className="btn btn-ghost p-2"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-full p-0.5 pr-1 transition hover:bg-panel-2"
            aria-label="Account menu"
            aria-expanded={menuOpen}
          >
            <Avatar name={user?.name ?? 'User'} src={user?.avatarUrl} size={30} />
          </button>

          {menuOpen && (
            <div className="animate-pop-in absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-elevated shadow-panel">
              <div className="border-b border-line px-3.5 py-3">
                <p className="truncate text-[13px] font-semibold text-body">{user?.name}</p>
                <p className="truncate text-[11px] text-dim">{user?.email}</p>
              </div>
              <div className="p-1.5">
                {[
                  { label: 'Settings', icon: Settings, to: '/settings' },
                  { label: 'API keys', icon: KeyRound, to: '/api' },
                ].map((item) => (
                  <button
                    key={item.to}
                    onClick={() => {
                      setMenuOpen(false)
                      navigate(item.to)
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-dim transition hover:bg-panel-2 hover:text-body"
                  >
                    <item.icon size={15} />
                    {item.label}
                  </button>
                ))}
                <button
                  onClick={async () => {
                    setMenuOpen(false)
                    await signOut()
                    navigate('/login')
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-dim transition hover:bg-panel-2 hover:text-danger"
                >
                  <LogOut size={15} />
                  Sign out
                </button>
              </div>
              <div className="border-t border-line px-3.5 py-2 text-[10px] text-faint">
                PSDrive v2.0 · <Link to="/settings" className="hover:text-dim">self-hosted</Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
