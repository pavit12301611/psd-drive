import { useEffect, useState } from 'react'
import { ArrowRight, Cloud, HardDrive, Layers, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { useAuth } from '../lib/app-context'
import { fetchInstance, googleSignInUrl, type InstanceInfo } from '../lib/api'
import { navigate } from '../lib/router'
import { BrandMark } from '../components/sidebar'
import { Spinner } from '../components/ui'

export function LoginPage() {
  const { signIn, signUp, signInDemo } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'form' | 'demo' | 'google' | null>(null)
  const [instance, setInstance] = useState<InstanceInfo | null>(null)

  useEffect(() => {
    fetchInstance().then(setInstance).catch(() => setInstance(null))

    // The Google callback lands back here with a machine-readable reason when
    // something went wrong.
    const params = new URLSearchParams(window.location.search)
    if (params.get('google') === 'error') {
      setError(params.get('message') ?? 'Google sign-in did not complete.')
      window.history.replaceState({}, '', '/login')
    }
  }, [])

  const continueWithGoogle = async () => {
    setError(null)
    setBusy('google')
    try {
      window.location.href = await googleSignInUrl('/drive')
    } catch (err) {
      setError((err as Error).message)
      setBusy(null)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setBusy('form')
    try {
      if (mode === 'signin') await signIn(email, password)
      else await signUp(name, email, password)
      navigate('/drive')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const demo = async () => {
    setError(null)
    setBusy('demo')
    try {
      await signInDemo()
      navigate('/drive')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* Brand panel */}
      <div className="relative hidden flex-1 overflow-hidden bg-[#080b12] lg:block">
        <div className="brand-gradient absolute -top-40 -left-32 size-[520px] rounded-full opacity-25 blur-[120px]" />
        <div className="absolute -right-20 bottom-0 size-[420px] rounded-full bg-cyan-500/20 blur-[120px]" />
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,.12) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,.12) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at 30% 30%, black 20%, transparent 75%)',
          }}
        />

        <div className="relative flex h-full flex-col justify-between p-12">
          <div className="flex items-center gap-3">
            <BrandMark size={36} />
            <div>
              <p className="text-[17px] font-semibold tracking-tight text-white">PSDrive</p>
              <p className="text-[10px] tracking-[0.14em] text-white/40 uppercase">One drive, every cloud</p>
            </div>
          </div>

          <div className="max-w-md">
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-white">
              Your free cloud storage,
              <br />
              <span className="text-gradient">pooled into one drive.</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-white/55">
              Connect every Google Drive account and S3 bucket you own. PSDrive presents them as a single file
              manager and sends each upload to whichever account still has room.
            </p>

            <div className="mt-9 space-y-3.5">
              {[
                { icon: Layers, title: 'One storage pool', text: 'See combined free space across every account.' },
                { icon: Zap, title: 'Streams, never buffers', text: 'A 4 GB upload costs the server no more memory than a 4 KB one.' },
                { icon: ShieldCheck, title: 'Yours alone', text: 'Self-hosted. Credentials encrypted at rest. No telemetry.' },
              ].map((item) => (
                <div key={item.title} className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-white/80">
                    <item.icon size={15} />
                  </span>
                  <div>
                    <p className="text-[13.5px] font-medium text-white/90">{item.title}</p>
                    <p className="text-[12.5px] text-white/45">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-6 text-[11px] text-white/35">
            <span className="flex items-center gap-1.5">
              <Cloud size={12} /> Google Drive
            </span>
            <span className="flex items-center gap-1.5">
              <HardDrive size={12} /> S3 · R2 · MinIO
            </span>
            <span className="flex items-center gap-1.5">
              <Sparkles size={12} /> Local disk
            </span>
          </div>
        </div>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center bg-app px-5 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <BrandMark size={34} />
            <div>
              <p className="text-[16px] font-semibold tracking-tight text-body">PSDrive</p>
              <p className="text-[10px] tracking-[0.12em] text-faint uppercase">One drive, every cloud</p>
            </div>
          </div>

          <h2 className="text-[22px] font-semibold tracking-tight text-body">
            {mode === 'signin' ? 'Welcome back' : 'Create your drive'}
          </h2>
          <p className="mt-1 mb-6 text-[13px] text-dim">
            {mode === 'signin' ? 'Sign in to reach all your connected storage.' : 'One account, every cloud you own.'}
          </p>

          {instance?.google.configured && (
            <>
              <button className="btn btn-outline w-full py-2.5" onClick={continueWithGoogle} disabled={busy !== null}>
                {busy === 'google' ? <Spinner size={15} /> : <GoogleMark />}
                Continue with Google
              </button>
              <p className="mt-2 text-center text-[11px] text-faint">
                Signs you in and connects that Google Drive in one step.
              </p>
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="text-[10.5px] tracking-wide text-faint uppercase">or use email</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>
            </>
          )}

          <form onSubmit={submit} className="space-y-3.5">
            {mode === 'signup' && (
              <label className="block">
                <span className="label">Name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                  required
                />
              </label>
            )}

            <label className="block">
              <span className="label">Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="block">
              <span className="label">Password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                minLength={8}
                required
              />
            </label>

            {error && (
              <p className="rounded-lg bg-[var(--danger-soft)] px-3 py-2 text-[12.5px] text-danger" role="alert">
                {error}
              </p>
            )}

            <button type="submit" className="btn btn-primary w-full py-2.5" disabled={busy !== null}>
              {busy === 'form' ? <Spinner size={15} /> : null}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
              {busy !== 'form' && <ArrowRight size={15} />}
            </button>
          </form>

          {instance?.demoMode && (
            <>
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-[var(--border)]" />
                <span className="text-[10.5px] tracking-wide text-faint uppercase">or</span>
                <span className="h-px flex-1 bg-[var(--border)]" />
              </div>

              <button className="btn btn-outline w-full py-2.5" onClick={demo} disabled={busy !== null}>
                {busy === 'demo' ? <Spinner size={15} /> : <Sparkles size={15} />}
                Explore the demo workspace
              </button>
              <p className="mt-2 text-center text-[11px] text-faint">
                Loads a ready-made drive with sample files and three accounts.
              </p>
            </>
          )}

          {instance?.needsSetup ? (
            <p className="mt-6 text-center text-[12.5px] text-dim">
              This instance is brand new.{' '}
              <button className="font-medium text-accent hover:underline" onClick={() => navigate('/setup')}>
                Run the 3-step setup
              </button>
            </p>
          ) : instance && !instance.signupOpen ? (
            <p className="mt-6 text-center text-[12px] text-faint">
              This instance is not accepting new sign-ups. Ask the owner for access.
            </p>
          ) : (
          <p className="mt-6 text-center text-[12.5px] text-dim">
            {mode === 'signin' ? "Don't have an account?" : 'Already have one?'}{' '}
            <button
              className="font-medium text-accent hover:underline"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin')
                setError(null)
              }}
            >
              {mode === 'signin' ? 'Create one' : 'Sign in'}
            </button>
          </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** The four-colour G, inline so it costs no extra request. */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.5 14.5 0 0 1 9.77 24c0-1.6.27-3.14.76-4.59l-7.97-6.19A23.94 23.94 0 0 0 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}
