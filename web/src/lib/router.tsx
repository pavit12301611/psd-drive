import { useCallback, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from 'react'

/**
 * A 40-line History-API router.
 *
 * A seven-route app does not need a routing library, and shipping without one
 * keeps the bundle small and the mental model obvious.
 */

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

const snapshot = () => window.location.pathname + window.location.search

export function useLocation(): { path: string; search: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot, () => '/')
  const [path, query = ''] = href.split('?')
  return { path, search: new URLSearchParams(query) }
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState({}, '', to)
  else window.history.pushState({}, '', to)
  emit()
  window.scrollTo({ top: 0 })
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = path.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i]
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(pathParts[i])
    else if (p !== pathParts[i]) return null
  }
  return params
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handle = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event)
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      navigate(to)
    },
    [to, onClick],
  )

  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  )
}
