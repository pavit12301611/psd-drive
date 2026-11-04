/**
 * A tiny event bus so mutations in one part of the app can tell the shell to
 * re-fetch (storage pool, folder tree) without threading callbacks everywhere.
 */

type Events = {
  refresh: undefined
  upload: undefined
}

export function emit(event: keyof Events): void {
  window.dispatchEvent(new CustomEvent(`psdrive:${event}`))
}

export function on(event: keyof Events, handler: () => void): () => void {
  const listener = () => handler()
  window.addEventListener(`psdrive:${event}`, listener)
  return () => window.removeEventListener(`psdrive:${event}`, listener)
}
