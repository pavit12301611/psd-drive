import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, KeyRound, Plus, Terminal, Trash2 } from 'lucide-react'
import { api, type ApiKeyRecord } from '../lib/api'
import { useToast } from '../lib/app-context'
import { timeAgo } from '../lib/format'
import { Chip, EmptyState, Field, Modal, Spinner } from '../components/ui'

export function ApiKeysPage() {
  const { toast } = useToast()
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['upload', 'read'])
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => api.get<{ keys: ApiKeyRecord[] }>('/api/api-keys').then((data) => setKeys(data.keys))

  useEffect(() => {
    void load()
  }, [])

  const baseUrl = window.location.origin

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await api.post<{ key: { secret: string; name: string } }>('/api/api-keys', { name, scopes })
      setIssued(result.key)
      setCreateOpen(false)
      setName('')
      await load()
    } catch (err) {
      toast({ title: 'Could not create key', description: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (key: ApiKeyRecord) => {
    try {
      await api.del(`/api/api-keys/${key.id}`)
      toast({ title: 'Key revoked', description: key.name, tone: 'success' })
      await load()
    } catch (err) {
      toast({ title: 'Could not revoke', description: (err as Error).message, tone: 'error' })
    }
  }

  const copy = async (value: string, id: string) => {
    await navigator.clipboard?.writeText(value).catch(() => {})
    setCopied(id)
    setTimeout(() => setCopied(null), 1600)
  }

  const snippet = `curl -X POST "${baseUrl}/api/v1/files?name=report.pdf" \\
  -H "X-API-Key: ${issued?.secret ?? 'psd_your_key'}" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @report.pdf`

  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pb-24 pt-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-body">API keys</h1>
          <p className="mt-0.5 text-[12.5px] text-dim">Push files into your pool from scripts, CI or another app.</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> Create key
        </button>
      </div>

      {!keys ? (
        <div className="skeleton h-24 w-full" />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No API keys yet"
          description="Create a key to upload files over HTTP. Keys are shown once and stored hashed."
          action={
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Create your first key
            </button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {keys.map((key) => (
            <div key={key.id} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-3 last:border-0">
              <span className="flex size-9 items-center justify-center rounded-lg bg-panel-2 text-dim">
                <KeyRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-[13px] font-medium text-body">{key.name}</p>
                  {key.revoked && <Chip tone="danger">REVOKED</Chip>}
                </div>
                <p className="text-[11px] text-faint">
                  {key.prefix}•••••••• · {key.scopes.join(', ')} ·{' '}
                  {key.lastUsedAt ? `used ${timeAgo(key.lastUsedAt)}` : 'never used'} · created {timeAgo(key.createdAt)}
                </p>
              </div>
              {!key.revoked && (
                <button className="btn btn-ghost btn-sm p-2 hover:text-danger" onClick={() => void revoke(key)} aria-label="Revoke key">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="flex items-center gap-2 text-[12px] font-semibold text-body">
            <Terminal size={14} className="text-accent" /> Upload with cURL
          </h2>
          <pre className="mt-2.5 overflow-x-auto rounded-lg bg-panel-2 p-3 font-mono text-[11px] leading-relaxed text-dim">
            {snippet}
          </pre>
          <button className="btn btn-outline btn-sm mt-2.5" onClick={() => void copy(snippet, 'curl')}>
            {copied === 'curl' ? <Check size={13} /> : <Copy size={13} />} Copy
          </button>
        </div>

        <div className="card p-4">
          <h2 className="text-[12px] font-semibold text-body">Endpoints</h2>
          <div className="mt-2.5 space-y-2 font-mono text-[11px] text-dim">
            {[
              ['POST', '/api/v1/files?name=<file>', 'Upload (raw body)'],
              ['GET', '/api/v1/files', 'List files'],
              ['GET', '/api/v1/files/:id/download', 'Download'],
              ['DELETE', '/api/v1/files/:id', 'Delete permanently'],
              ['GET', '/api/v1/usage', 'Pool + account usage'],
            ].map(([method, path, label]) => (
              <div key={path} className="flex items-start gap-2">
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold"
                  style={{
                    background: method === 'GET' ? 'rgba(96,165,250,.16)' : method === 'DELETE' ? 'var(--danger-soft)' : 'var(--accent-soft)',
                    color: method === 'GET' ? '#60a5fa' : method === 'DELETE' ? 'var(--danger)' : 'var(--accent-text)',
                  }}
                >
                  {method}
                </span>
                <span className="min-w-0 flex-1 break-all">{path}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            Authenticate with <span className="font-mono text-dim">X-API-Key</span>. Scopes: upload, read, delete.
          </p>
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key" width="max-w-md">
        <form onSubmit={create} className="space-y-3">
          <Field label="Key name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="CI uploads" required autoFocus />
          </Field>
          <div>
            <span className="label">Scopes</span>
            <div className="flex gap-2">
              {['upload', 'read', 'delete'].map((scope) => {
                const active = scopes.includes(scope)
                return (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setScopes(active ? scopes.filter((s) => s !== scope) : [...scopes, scope])}
                    className={`rounded-lg border px-2.5 py-1.5 text-[12px] transition ${
                      active ? 'border-[var(--accent)] bg-accent-soft text-accent' : 'border-line text-dim hover:bg-panel-2'
                    }`}
                  >
                    {scope}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || scopes.length === 0}>
              {busy ? <Spinner size={14} /> : null} Create key
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(issued)} onClose={() => setIssued(null)} title="Copy your key now" width="max-w-lg">
        <div className="flex items-start gap-2 rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[11.5px] text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          This is the only time the key is shown. We store only a hash of it.
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input readOnly value={issued?.secret ?? ''} className="input font-mono text-[12px]" onFocus={(e) => e.target.select()} />
          <button className="btn btn-outline" onClick={() => void copy(issued?.secret ?? '', 'secret')}>
            {copied === 'secret' ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </div>
        <div className="mt-4 flex justify-end">
          <button className="btn btn-primary" onClick={() => setIssued(null)}>
            Done
          </button>
        </div>
      </Modal>
    </div>
  )
}
