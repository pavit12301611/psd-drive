import { useEffect, useState } from 'react'
import { Check, Cloud, ExternalLink, Info, LogOut, Moon, Server, Sun } from 'lucide-react'
import { api } from '../lib/api'
import { useAuth, useTheme, useToast } from '../lib/app-context'
import { formatBytes } from '../lib/format'
import { navigate } from '../lib/router'
import { Chip, Field, Spinner } from '../components/ui'

type SettingsResponse = {
  user: { id: string; name: string; email: string; role: string }
  google: { configured: boolean; clientId: string | null; redirectUri: string; usingEnv: boolean }
  instance: { appUrl: string; demoMode: boolean; maxUploadBytes: number; version: string }
  storage: { accounts: number; dataDir: string }
}

export function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const { user, signOut } = useAuth()
  const { toast } = useToast()
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api.get<SettingsResponse>('/api/settings').then((data) => {
      setSettings(data)
      setClientId(data.google.clientId ?? '')
    })

  useEffect(() => {
    void load()
  }, [])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await api.put('/api/settings/google', {
        clientId,
        clientSecret: clientSecret || undefined,
        redirectUri: settings?.google.redirectUri,
      })
      setClientSecret('')
      await load()
      toast({ title: 'Google credentials saved', tone: 'success' })
    } catch (err) {
      toast({ title: 'Could not save', description: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[840px] px-4 pb-24 pt-5 sm:px-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-body">Settings</h1>
        <p className="mt-0.5 text-[12.5px] text-dim">Connect Google, check your instance, tune the look.</p>
      </div>

      <div className="space-y-4">
        {/* Google OAuth */}
        <section className="card p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-body">
                <Cloud size={15} className="text-accent" /> Google Drive credentials
              </h2>
              <p className="mt-1 text-[12px] leading-relaxed text-dim">
                Create an OAuth client in Google Cloud Console, enable the Drive API, and paste the client ID and
                secret here. You can also set <code className="rounded bg-panel-2 px-1 py-0.5 text-[11px]">GOOGLE_CLIENT_ID</code> and{' '}
                <code className="rounded bg-panel-2 px-1 py-0.5 text-[11px]">GOOGLE_CLIENT_SECRET</code> in your environment.
              </p>
            </div>
            {settings?.google.configured ? <Chip tone="success">CONFIGURED</Chip> : <Chip>NOT SET</Chip>}
          </div>

          <form onSubmit={save} className="mt-3 space-y-3">
            <Field label="Client ID">
              <input
                className="input font-mono text-[12px]"
                placeholder="1234567890-abc.apps.googleusercontent.com"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                disabled={settings?.google.usingEnv}
              />
            </Field>
            <Field label="Client secret" hint={settings?.google.usingEnv ? 'Managed by the GOOGLE_CLIENT_SECRET environment variable.' : 'Stored encrypted with AES-256-GCM. Leave blank to keep the current secret.'}>
              <input
                className="input font-mono text-[12px]"
                type="password"
                placeholder="GOCSPX-…"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                disabled={settings?.google.usingEnv}
              />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-panel-2 px-3 py-2">
              <div className="min-w-0">
                <p className="text-[10.5px] tracking-wide text-faint uppercase">Authorized redirect URI</p>
                <p className="truncate font-mono text-[11px] text-dim">{settings?.google.redirectUri}</p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-sm shrink-0"
                onClick={() => {
                  void navigator.clipboard?.writeText(settings?.google.redirectUri ?? '')
                  toast({ title: 'Redirect URI copied', tone: 'success' })
                }}
              >
                Copy
              </button>
            </div>
            {!settings?.google.usingEnv && (
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !clientId}>
                {busy ? <Spinner size={13} /> : <Check size={13} />} Save credentials
              </button>
            )}
          </form>
        </section>

        {/* Appearance */}
        <section className="card p-4">
          <h2 className="text-[13px] font-semibold text-body">Appearance</h2>
          <p className="mt-1 text-[12px] text-dim">Follows your system by default; pick one to pin it.</p>
          <div className="mt-3 flex gap-2">
            {[
              { id: 'dark' as const, label: 'Dark', icon: Moon },
              { id: 'light' as const, label: 'Light', icon: Sun },
            ].map((option) => (
              <button
                key={option.id}
                onClick={() => setTheme(option.id)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-3 py-3 text-[12.5px] transition ${
                  theme === option.id ? 'border-[var(--accent)] bg-accent-soft text-accent' : 'border-line text-dim hover:bg-panel-2'
                }`}
              >
                <option.icon size={15} /> {option.label}
              </button>
            ))}
          </div>
        </section>

        {/* Instance */}
        <section className="card p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-semibold text-body">
            <Server size={15} className="text-accent" /> Instance
          </h2>
          <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2">
            {[
              ['Version', settings?.instance.version ?? '—'],
              ['App URL', settings?.instance.appUrl ?? '—'],
              ['Max upload', settings ? formatBytes(settings.instance.maxUploadBytes) : '—'],
              ['Demo mode', settings?.instance.demoMode ? 'On' : 'Off'],
              ['Connected accounts', String(settings?.storage.accounts ?? 0)],
              ['Signed in as', user?.email ?? '—'],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3 border-b border-line py-1.5 last:border-0 sm:border-0">
                <dt className="text-faint">{label}</dt>
                <dd className="truncate font-medium text-body">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="card p-4">
          <h2 className="text-[13px] font-semibold text-body">Session</h2>
          <p className="mt-1 text-[12px] text-dim">Signing out clears the refresh cookie on this device.</p>
          <button
            className="btn btn-danger btn-sm mt-3"
            onClick={async () => {
              await signOut()
              navigate('/login')
            }}
          >
            <LogOut size={13} /> Sign out
          </button>
        </section>

        <div className="flex items-start gap-2 rounded-xl border border-line bg-panel-2 px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
          <Info size={14} className="mt-0.5 shrink-0 text-faint" />
          <p>
            PSDrive stores its database and blobs in the <code className="rounded bg-panel px-1 py-0.5">./data</code>{' '}
            directory (override ith <code className="rounded bg-panel px-1 py-0.5">DATA_DIR</code>). Back up that folder
            and you have backed up everything.{' '}
            <a href="/healthz" target="_blank" rel="noreferrer" className="text-accent hover:underline">
              Health check <ExternalLink size={10} className="inline" />
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
