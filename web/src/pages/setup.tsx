import { useEffect, useMemo, useState } from 'react'
import {
  ArrowRight,
  Check,
  ClipboardCopy,
  Cloud,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react'
import { fetchInstance, api, type InstanceInfo } from '../lib/api'
import { useAuth } from '../lib/app-context'
import { navigate } from '../lib/router'
import { BrandMark } from '../components/sidebar'
import { Spinner } from '../components/ui'

/**
 * First run, for real.
 *
 * Three steps and the app is genuinely wired to somebody's Google Drive:
 * create the owner account, paste the OAuth client (with the exact redirect
 * URI to register in Cloud Console), then run the consent screen.
 *
 * The screen is also reachable later from Storage → "Finish setup", so an
 * instance that was started without Google can be completed at any time.
 */

type Step = 'account' | 'credentials' | 'connect'

const CONSOLE_STEPS = [
  {
    title: 'Open Google Cloud Console',
    body: 'Pick or create a project. Everything below lives inside that project.',
  },
  {
    title: 'Enable the Google Drive API',
    body: 'APIs & Services → Library → search "Google Drive API" → Enable. Without this, Google rejects every Drive call.',
  },
  {
    title: 'Configure the OAuth consent screen',
    body: 'Choose External (or Internal for a Google Workspace domain). Add your own Google account under Test users if the app is still in Testing.',
  },
  {
    title: 'Create an OAuth client',
    body: 'Credentials → Create credentials → OAuth client ID → Application type: Web application.',
  },
  {
    title: 'Paste the redirect URI',
    body: 'Add the exact URL shown below to "Authorised redirect URIs". It must match character for character.',
  },
  {
    title: 'Copy the client ID and secret',
    body: 'Paste both into the form. The secret is encrypted with AES-256-GCM before it touches the database.',
  },
]

export function SetupPage() {
  const { user, signUp } = useAuth()
  const [instance, setInstance] = useState<InstanceInfo | null>(null)
  const [step, setStep] = useState<Step>('account')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  useEffect(() => {
    fetchInstance()
      .then((info) => {
        setInstance(info)
        if (info.needsSetup) setStep('account')
        else if (!info.google.configured) setStep('credentials')
        else setStep('connect')
      })
      .catch(() => setStep('credentials'))
  }, [])

  // Someone who is already signed in should not see the account step.
  useEffect(() => {
    if (user && step === 'account' && instance && !instance.needsSetup) {
      setStep(instance.google.configured ? 'connect' : 'credentials')
    }
  }, [user, step, instance])

  const redirectUri = useMemo(
    () => instance?.google.redirectUri ?? `${typeof window === 'undefined' ? '' : window.location.origin}/api/oauth/google/callback`,
    [instance],
  )

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signUp(name, email, password)
      setStep('credentials')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const saveCredentials = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await api.put('/api/settings/google', {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        redirectUri,
      })
      setStep('connect')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const connectDrive = async () => {
    setError(null)
    setBusy(true)
    try {
      const { url } = await api.post<{ url: string }>('/api/oauth/google/url')
      window.location.href = url
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const copyRedirect = async () => {
    try {
      await navigator.clipboard.writeText(redirectUri)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — the URL is visible and selectable */
    }
  }

  const steps: { id: Step; label: string; icon: typeof UserRound }[] = [
    { id: 'account', label: 'Your account', icon: UserRound },
    { id: 'credentials', label: 'Google credentials', icon: KeyRound },
    { id: 'connect', label: 'Connect Drive', icon: Cloud },
  ]

  return (
    <div className="min-h-full bg-app">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 py-10">
        <header className="flex items-center gap-3">
          <BrandMark size={34} />
          <div>
            <p className="text-[16px] font-semibold tracking-tight text-body">PSDrive</p>
            <p className="text-[10px] tracking-[0.14em] text-faint uppercase">Set up your instance</p>
          </div>
          {user && (
            <button className="ml-auto text-[12.5px] text-dim hover:text-body" onClick={() => navigate('/drive')}>
              Skip for now
            </button>
          )}
        </header>

        <ol className="mt-8 flex flex-wrap items-center gap-2 text-[12.5px]">
          {steps.map((item, index) => {
            const active = item.id === step
            const done = steps.findIndex((entry) => entry.id === step) > index
            return (
              <li key={item.id} className="flex items-center gap-2">
                <span
                  className={`flex size-6 items-center justify-center rounded-full border text-[11px] ${
                    done
                      ? 'border-transparent bg-[var(--success)] text-white'
                      : active
                        ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] text-accent'
                        : 'border-line text-faint'
                  }`}
                >
                  {done ? <Check size={12} /> : index + 1}
                </span>
                <span className={active ? 'font-medium text-body' : 'text-dim'}>{item.label}</span>
                {index < steps.length - 1 && <span className="mx-1 h-px w-6 bg-[var(--border)]" />}
              </li>
            )
          })}
        </ol>

        <div className="mt-6 grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="card p-6">
            {step === 'account' && (
              <form onSubmit={createAccount} className="max-w-md space-y-4">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-tight text-body">Create the owner account</h1>
                  <p className="mt-1 text-[13px] text-dim">
                    This is the account you sign in with. It is local to this server — nothing is sent anywhere.
                  </p>
                </div>

                <label className="block">
                  <span className="label">Name</span>
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" required />
                </label>
                <label className="block">
                  <span className="label">Email</span>
                  <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" required />
                </label>
                <label className="block">
                  <span className="label">Password</span>
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                  <span className="mt-1.5 block text-[11.5px] text-faint">Hashed with scrypt. There is no password reset email — keep it safe.</span>
                </label>

                {error && <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] text-danger">{error}</p>}

                <button className="btn btn-primary w-full py-2.5" disabled={busy}>
                  {busy ? <Spinner size={15} /> : null}
                  Continue
                  {!busy && <ArrowRight size={15} />}
                </button>
              </form>
            )}

            {step === 'credentials' && (
              <form onSubmit={saveCredentials} className="space-y-4">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-tight text-body">Connect Google Drive</h1>
                  <p className="mt-1 max-w-lg text-[13px] leading-relaxed text-dim">
                    PSDrive uploads into a folder called <span className="font-medium text-body">PSDrive</span> inside your own
                    Drive. To do that it needs an OAuth client — Google's way of letting an app act on your behalf.
                  </p>
                </div>

                <div className="rounded-xl border border-line bg-[var(--panel-2)] p-3">
                  <p className="text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">Redirect URI to register</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-body">{redirectUri}</code>
                    <button type="button" className="btn btn-outline btn-sm shrink-0" onClick={copyRedirect}>
                      {copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
                    Google Cloud Console → APIs &amp; Services → Credentials → your OAuth client → Authorised redirect URIs.
                    A mismatch here is the most common reason a connection fails.
                  </p>
                </div>

                <label className="block">
                  <span className="label">Client ID</span>
                  <input
                    className="input font-mono text-[12.5px]"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="1234567890-abc123.apps.googleusercontent.com"
                    required
                  />
                </label>
                <label className="block">
                  <span className="label">Client secret</span>
                  <input
                    className="input font-mono text-[12.5px]"
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder="GOCSPX-…"
                    required
                  />
                  <span className="mt-1.5 block text-[11.5px] text-faint">Stored encrypted (AES-256-GCM). It never leaves this server.</span>
                </label>

                {error && <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] text-danger">{error}</p>}

                <div className="flex items-center gap-2">
                  <button className="btn btn-primary" disabled={busy}>
                    {busy ? <Spinner size={15} /> : null}
                    Save and continue
                    {!busy && <ArrowRight size={15} />}
                  </button>
                  <a
                    className="btn btn-outline"
                    href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={14} /> Enable Drive API
                  </a>
                </div>
              </form>
            )}

            {step === 'connect' && (
              <div className="max-w-md space-y-4">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-tight text-body">Authorise your Google Drive</h1>
                  <p className="mt-1 text-[13px] leading-relaxed text-dim">
                    You will see Google's consent screen. PSDrive asks for Drive access, and keeps a refresh token encrypted
                    on this server so uploads keep working after the first hour.
                  </p>
                </div>

                <button className="btn btn-primary w-full py-2.5" onClick={connectDrive} disabled={busy}>
                  {busy ? <Spinner size={15} /> : <Cloud size={15} />}
                  Connect Google Drive
                </button>

                <p className="flex items-start gap-2 rounded-lg bg-[var(--panel-2)] px-3 py-2.5 text-[11.5px] leading-relaxed text-dim">
                  <ShieldCheck size={14} className="mt-0.5 shrink-0 text-accent" />
                  Access can be revoked at any time from{' '}
                  <a className="underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
                    your Google account
                  </a>
                  . If the Google app is still in "Testing", Google expires refresh tokens after 7 days — publish the app
                  (or set it to Internal) to keep the connection alive.
                </p>

                {error && <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] text-danger">{error}</p>}

                <button className="text-[12.5px] text-dim hover:text-body" onClick={() => navigate('/drive')}>
                  I will connect storage later
                </button>
              </div>
            )}
          </section>

          <aside className="card h-fit p-5">
            <p className="flex items-center gap-2 text-[13px] font-medium text-body">
              <Sparkles size={14} className="text-accent" /> Getting the credentials
            </p>
            <ol className="mt-3 space-y-3">
              {CONSOLE_STEPS.map((item, index) => (
                <li key={item.title} className="flex gap-2.5">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--panel-2)] text-[10.5px] font-semibold text-dim">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-[12.5px] font-medium text-body">{item.title}</p>
                    <p className="mt-0.5 text-[11.5px] leading-relaxed text-faint">{item.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 border-t border-line pt-3 text-[11.5px] leading-relaxed text-faint">
              Prefer the terminal? Set <code className="text-dim">GOOGLE_CLIENT_ID</code> and{' '}
              <code className="text-dim">GOOGLE_CLIENT_SECRET</code> and this step is skipped entirely.
            </p>
          </aside>
        </div>
      </div>
    </div>
  )
}
