import { useEffect, useState } from 'react'
import { Check, Copy, Download, ExternalLink, Link2, Share2, Trash2 } from 'lucide-react'
import { api, type Share } from '../lib/api'
import { useToast } from '../lib/app-context'
import { emit } from '../lib/bus'
import { formatBytes, timeAgo } from '../lib/format'
import { FileTile } from '../components/file-icon'
import { EmptyState, Spinner } from '../components/ui'

export function SharedPage() {
  const { toast } = useToast()
  const [shares, setShares] = useState<Share[] | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const load = () => {
    api
      .get<{ shares: Share[] }>('/api/shares')
      .then((data) => setShares(data.shares))
      .catch((err: Error) => toast({ title: 'Could not load shares', description: err.message, tone: 'error' }))
  }

  useEffect(load, [])

  const copy = async (share: Share) => {
    await navigator.clipboard?.writeText(share.url).catch(() => {})
    setCopied(share.id)
    setTimeout(() => setCopied(null), 1600)
    toast({ title: 'Link copied', description: share.url, tone: 'success' })
  }

  const revoke = async (share: Share) => {
    try {
      await api.del(`/api/shares/${share.id}`)
      toast({ title: 'Link revoked', description: share.fileName, tone: 'success' })
      load()
      emit('refresh')
    } catch (err) {
      toast({ title: 'Could not revoke', description: (err as Error).message, tone: 'error' })
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 pb-24 pt-5 sm:px-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-body">Shared links</h1>
        <p className="mt-0.5 text-[12.5px] text-dim">
          Anyone with a link can view or download the file. Revoke a link any time.
        </p>
      </div>

      {!shares ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-16 w-full" />
          ))}
        </div>
      ) : shares.length === 0 ? (
        <EmptyState
          icon={<Share2 size={20} />}
          title="No shared links yet"
          description="Right-click any file and choose “Share link” to create one."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          {shares.map((share) => (
            <div key={share.id} className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-3 last:border-0">
              <FileTile kind={share.kind} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-body">{share.fileName}</p>
                <p className="truncate text-[11px] text-faint">
                  {formatBytes(share.sizeBytes)} · {share.accountLabel} · shared {timeAgo(share.createdAt)}
                  {share.expiresAt ? ` · expires ${new Date(share.expiresAt).toLocaleDateString()}` : ''}
                </p>
              </div>

              <div className="flex items-center gap-3 text-[11px] text-faint">
                <span className="tabular-nums">{share.views} views</span>
                <span className="tabular-nums">{share.downloads} downloads</span>
              </div>

              <div className="flex items-center gap-1">
                <button className="btn btn-outline btn-sm" onClick={() => void copy(share)}>
                  {copied === share.id ? <Check size={13} /> : <Copy size={13} />}
                  {copied === share.id ? 'Copied' : 'Copy link'}
                </button>
                <a className="btn btn-ghost btn-sm p-2" href={share.url} target="_blank" rel="noreferrer" aria-label="Open link">
                  <ExternalLink size={14} />
                </a>
                <a className="btn btn-ghost btn-sm p-2" href={`/api/public/${share.token}/download`} aria-label="Download">
                  <Download size={14} />
                </a>
                <button
                  className="btn btn-ghost btn-sm p-2 hover:text-danger"
                  onClick={() => void revoke(share)}
                  aria-label="Revoke link"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-line bg-panel-2 px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
        <Link2 size={14} className="mt-0.5 shrink-0 text-faint" />
        <p>
          Share links stream directly from the connected provider, so viewers never need an account and the file is
          never copied to a second location.
        </p>
      </div>
    </div>
  )
}
