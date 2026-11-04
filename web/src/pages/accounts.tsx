import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Cloud,
  Database,
  HardDrive,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react'
import { api, type Account, type PoolSummary } from '../lib/api'
import { useToast } from '../lib/app-context'
import { emit } from '../lib/bus'
import { formatBytes, timeAgo } from '../lib/format'
import { navigate, useLocation } from '../lib/router'
import { accountColor, type Stats } from '../lib/shell-data'
import { PoolCard, StackedMeter } from '../components/sidebar'
import { Chip, Field, Modal, Progress, Spinner } from '../components/ui'

type RoutingMode = 'most_available' | 'round_robin' | 'priority'

const ROUTING: { id: RoutingMode; title: string; description: string; icon: typeof Zap }[] = [
  {
    id: 'most_available',
    title: 'Most free space',
    description: 'Send each upload to the account with the most room. Keeps accounts balanced.',
    icon: Zap,
  },
  {
    id: 'round_robin',
    title: 'Round robin',
    description: 'Rotate accounts in order so usage spreads evenly across all of them.',
    icon: RefreshCw,
  },
  {
    id: 'priority',
    title: 'Priority order',
    description: 'Fill your preferred accounts first, using the rest as overflow.',
    icon: Check,
  },
]

export function AccountsPage({ stats, reload }: { stats: Stats | null; reload: () => void }) {
  const { search } = useLocation()
  const { toast } = useToast()
  const [accounts, setAccounts] = useState<Account[]>(stats?.accounts ?? [])
  const [pool, setPool] = useState<PoolSummary | null>(stats?.pool ?? null)
  const [policy, setPolicy] = useState<{ mode: RoutingMode; order: string[] }>({ mode: 'most_available', order: [] })
  const [s3Open, setS3Open] = useState(false)
  const [localOpen, setLocalOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (stats) {
      setAccounts(stats.accounts)
      setPool(stats.pool)
      setPolicy({ mode: (stats.policy?.mode as RoutingMode) ?? 'most_available', order: stats.policy?.order ?? [] })
    }
  }, [stats])

  // Surface the result of the Google OAuth round-trip.
  useEffect(() => {
    const result = search.get('google')
    if (!result) return
    if (result === 'connected') toast({ title: 'Google Drive connected', tone: 'success' })
    if (result === 'error') toast({ title: 'Google connection failed', description: search.get('message') ?? undefined, tone: 'error' })
    navigate('/accounts', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.toString()])

  const connectGoogle = async () => {
    try {
      const { url } = await api.post<{ url: string }>('/api/oauth/google/url')
      window.location.href = url
    } catch (err) {
      toast({ title: 'Google is not configured', description: (err as Error).message, tone: 'error' })
    }
  }

  const sync = async (account: Account) => {
    setBusyId(account.id)
    try {
      await api.post(`/api/accounts/${account.id}/sync`)
      toast({ title: 'Quota refreshed', description: account.label, tone: 'success' })
      reload()
    } catch (err) {
      toast({ title: 'Sync failed', description: (err as Error).message, tone: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (account: Account) => {
    try {
      await api.patch(`/api/accounts/${account.id}`, { enabled: account.status === 'disabled' })
      reload()
    } catch (err) {
      toast({ title: 'Could not update', description: (err as Error).message, tone: 'error' })
    }
  }

  const remove = async (account: Account) => {
    setBusyId(account.id)
    try {
      await api.del(`/api/accounts/${account.id}`)
      toast({ title: 'Account disconnected', description: `${account.label} was removed from your pool.`, tone: 'success' })
      reload()
      emit('refresh')
    } catch (err) {
      toast({ title: 'Could not disconnect', description: (err as Error).message, tone: 'error' })
    } finally {
      setBusyId(null)
    }
  }

  const changePolicy = async (mode: RoutingMode) => {
    setPolicy({ ...policy, mode })
    try {
      await api.put('/api/accounts/routing/policy', { mode, order: policy.order })
      toast({ title: 'Routing updated', description: ROUTING.find((r) => r.id === mode)?.title, tone: 'success' })
      reload()
    } catch (err) {
      toast({ title: 'Could not update routing', description: (err as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 pb-24 pt-5 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-body">Storage accounts</h1>
          <p className="mt-0.5 text-[12.5px] text-dim">
            Every account you connect adds its free space to one shared pool.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-outline btn-sm"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true)
              try {
                await api.post('/api/accounts/sync-all')
                reload()
                toast({ title: 'All quotas refreshed', tone: 'success' })
              } finally {
                setRefreshing(false)
              }
            }}
          >
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={13} />} Refresh quotas
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setS3Open(true)}>
            <Plus size={14} /> Connect storage
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.15fr_1fr]">
        <PoolCard stats={stats} />

        <div className="card p-4">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">Upload routing</h2>
          <p className="mt-1 text-[12px] text-dim">Where new files land when you have more than one account.</p>
          <div className="mt-3 space-y-1.5">
            {ROUTING.map((option) => {
              const active = policy.mode === option.id
              return (
                <button
                  key={option.id}
                  onClick={() => void changePolicy(option.id)}
                  className={`flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition ${
                    active ? 'border-[var(--accent)] bg-accent-soft' : 'border-line hover:bg-panel-2'
                  }`}
                >
                  <span className={`mt-0.5 ${active ? 'text-accent' : 'text-faint'}`}>
                    <option.icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[12.5px] font-medium ${active ? 'text-accent' : 'text-body'}`}>{option.title}</span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-dim">{option.description}</span>
                  </span>
                  <span
                    className={`mt-1 size-3.5 shrink-0 rounded-full border ${
                      active ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]'
                    }`}
                  />
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <h2 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">
          Connected accounts ({accounts.length})
        </h2>

        <div className="grid gap-3 sm:grid-cols-2">
          {accounts.map((account, index) => {
            const total = account.totalBytes ?? 0
            const pct = total > 0 ? (account.usedBytes / total) * 100 : 0
            const isBusy = busyId === account.id
            return (
              <div key={account.id} className="card p-4">
                <div className="flex items-start gap-3">
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl"
                    style={{ background: `${accountColor(index)}22`, color: accountColor(index) }}
                  >
                    {account.provider === 'google' ? <Cloud size={17} /> : account.provider === 's3' ? <Database size={17} /> : <Server size={17} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[13.5px] font-semibold text-body">{account.label}</p>
                      {account.isDemo && <Chip>DEMO</Chip>}
                      {account.status === 'error' && <Chip tone="danger">ERROR</Chip>}
                    </div>
                    <p className="truncate text-[11.5px] text-faint">
                      {account.email ?? account.detail}
                      {account.provider === 'google' && account.quotaSyncedAt ? ` · synced ${timeAgo(account.quotaSyncedAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      className="rounded p-1.5 text-faint transition hover:bg-panel-2 hover:text-body"
                      onClick={() => void sync(account)}
                      title="Refresh quota"
                      aria-label="Refresh quota"
                      disabled={isBusy}
                    >
                      {isBusy ? <Spinner size={13} /> : <RefreshCw size={13} />}
                    </button>
                    <button
                      className="rounded p-1.5 text-faint transition hover:bg-[var(--danger-soft)] hover:text-danger"
                      onClick={() => void remove(account)}
                      title="Disconnect"
                      aria-label="Disconnect account"
                      disabled={isBusy}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="mb-1 flex items-baseline justify-between text-[11px]">
                    <span className="tabular-nums text-dim">
                      {formatBytes(account.usedBytes)} used
                      {account.totalBytes ? ` of ${formatBytes(account.totalBytes)}` : ''}
                    </span>
                    <span className="font-medium tabular-nums text-body">
                      {account.availableBytes != null ? `${formatBytes(account.availableBytes)} free` : '∞'}
                    </span>
                  </div>
                  <Progress value={pct} height={5} tone={pct > 92 ? 'danger' : pct > 75 ? 'accent' : 'success'} />
                  {account.lastError && (
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-danger">
                      <AlertTriangle size={11} /> {account.lastError}
                    </p>
                  )}
                </div>
              </div>
            )
          })}

          {/* Add cards */}
          <button
            onClick={connectGoogle}
            className="flex flex-col items-start justify-center gap-1.5 rounded-2xl border border-dashed border-line px-4 py-5 text-left transition hover:border-[var(--accent)] hover:bg-panel-2"
          >
            <span className="flex items-center gap-2 text-[13px] font-medium text-body">
              <Cloud size={16} className="text-accent" /> Connect Google Drive
            </span>
            <span className="text-[11.5px] leading-relaxed text-dim">
              Adds 15 GB per account. Uploads land in a `PSDrive` folder in that Drive.
            </span>
          </button>

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setS3Open(true)}
              className="flex flex-col items-start justify-center gap-1.5 rounded-2xl border border-dashed border-line px-4 py-5 text-left transition hover:border-[var(--accent)] hover:bg-panel-2"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-body">
                <Database size={15} className="text-accent" /> S3 bucket
              </span>
              <span className="text-[11px] text-dim">AWS, R2, MinIO…</span>
            </button>
            <button
              onClick={() => setLocalOpen(true)}
              className="flex flex-col items-start justify-center gap-1.5 rounded-2xl border border-dashed border-line px-4 py-5 text-left transition hover:border-[var(--accent)] hover:bg-panel-2"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-body">
                <HardDrive size={15} className="text-accent" /> Local disk
              </span>
              <span className="text-[11px] text-dim">This server</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-start gap-2 rounded-xl border border-line bg-panel-2 px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-faint" />
        <p>
          Credentials are encrypted with AES-256-GCM using a key stored on this server only. Disconnecting an account
          removes it from PSDrive but never deletes files from the provider itself.
        </p>
      </div>

      <S3Modal open={s3Open} onClose={() => setS3Open(false)} onConnected={reload} />
      <LocalModal open={localOpen} onClose={() => setLocalOpen(false)} onConnected={reload} />
    </div>
  )
}

function S3Modal({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => void }) {
  const { toast } = useToast()
  const [form, setForm] = useState({
    label: '',
    bucket: '',
    region: 'auto',
    endpoint: '',
    accessKeyId: '',
    secretAccessKey: '',
    prefix: 'psdrive',
    forcePathStyle: true,
    quotaGb: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.post('/api/accounts/s3', {
        label: form.label,
        bucket: form.bucket,
        region: form.region || 'auto',
        endpoint: form.endpoint || undefined,
        accessKeyId: form.accessKeyId,
        secretAccessKey: form.secretAccessKey,
        prefix: form.prefix,
        forcePathStyle: form.forcePathStyle,
        quotaGb: form.quotaGb ? Number(form.quotaGb) : undefined,
      })
      toast({ title: 'Bucket connected', description: form.label, tone: 'success' })
      onClose()
      onConnected()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Connect an S3 bucket" description="Works with AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2 and any S3-compatible endpoint.">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Display name">
            <input className="input" placeholder="Backup bucket" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
          </Field>
          <Field label="Bucket">
            <input className="input" placeholder="my-bucket" value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })} required />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Region" hint="Use `auto` for R2.">
            <input className="input" placeholder="auto" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          </Field>
          <Field label="Endpoint" hint="Leave empty for AWS.">
            <input className="input" placeholder="https://…r2.cloudflarestorage.com" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
          </Field>
        </div>
        <Field label="Access key ID">
          <input className="input font-mono text-[12px]" value={form.accessKeyId} onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })} required />
        </Field>
        <Field label="Secret access key">
          <input className="input font-mono text-[12px]" type="password" value={form.secretAccessKey} onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Key prefix" hint="Objects are stored under this prefix.">
            <input className="input" value={form.prefix} onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
          </Field>
          <Field label="Quota (GB)" hint="Optional. Leave empty for unlimited.">
            <input className="input" type="number" min="0" placeholder="—" value={form.quotaGb} onChange={(e) => setForm({ ...form, quotaGb: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[12.5px] text-dim">
          <input type="checkbox" checked={form.forcePathStyle} onChange={(e) => setForm({ ...form, forcePathStyle: e.target.checked })} className="accent-[var(--accent)]" />
          Use path-style URLs (required by most non-AWS providers)
        </label>

        {error && <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} Test & connect
          </button>
        </div>
      </form>
    </Modal>
  )
}

function LocalModal({ open, onClose, onConnected }: { open: boolean; onClose: () => void; onConnected: () => void }) {
  const { toast } = useToast()
  const [label, setLabel] = useState('')
  const [quotaGb, setQuotaGb] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add local disk storage"
      description="Store files on this server's disk. Useful for a NAS mount or a fast local cache."
      width="max-w-md"
    >
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          try {
            await api.post('/api/accounts/local', { label, quotaGb: quotaGb ? Number(quotaGb) : undefined })
            toast({ title: 'Local storage added', tone: 'success' })
            onClose()
            onConnected()
          } catch (err) {
            toast({ title: 'Could not add storage', description: (err as Error).message, tone: 'error' })
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Display name">
          <input className="input" placeholder="Local disk" value={label} onChange={(e) => setLabel(e.target.value)} required />
        </Field>
        <Field label="Quota (GB)" hint="Leave empty to report the real free space of the disk.">
          <input className="input" type="number" min="0" placeholder="—" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner size={14} /> : null} Add storage
          </button>
        </div>
      </form>
    </Modal>
  )
}
