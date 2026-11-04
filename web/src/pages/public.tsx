import { useEffect, useState } from 'react'
import { Download, Link2, ShieldAlert } from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes, timeAgo } from '../lib/format'
import { BrandMark } from '../components/sidebar'
import { FileIcon } from '../components/file-icon'
import { Spinner } from '../components/ui'

type PublicShare = {
  token: string
  fileName: string
  mimeType: string
  kind: string
  inlineType: string
  sizeBytes: number
  provider: string
  expiresAt: number | null
  downloads: number
  views: number
  createdAt: number
  downloadUrl: string
  contentUrl: string
}

export function PublicPage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShare | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ share: PublicShare }>(`/api/public/${token}`)
      .then((data) => setShare(data.share))
      .catch((err: Error) => setError(err.message))
  }, [token])

  return (
    <div className="flex min-h-full flex-col bg-app">
      <header className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
        <div className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <div>
            <p className="text-[14px] font-semibold tracking-tight text-body">PSDrive</p>
            <p className="text-[10px] tracking-[0.1em] text-faint uppercase">Shared file</p>
          </div>
        </div>
        <a href="/" className="btn btn-outline btn-sm">
          <Link2 size={13} /> Open PSDrive
        </a>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        {error ? (
          <div className="card mx-auto max-w-md px-6 py-10 text-center">
            <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-xl bg-[var(--danger-soft)] text-danger">
              <ShieldAlert size={20} />
            </div>
            <h1 className="text-sm font-semibold text-body">This link is not available</h1>
            <p className="mt-1 text-[12.5px] text-dim">{error}</p>
          </div>
        ) : !share ? (
          <div className="flex h-64 items-center justify-center text-dim">
            <Spinner size={20} />
          </div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-panel-2">
                  <FileIcon kind={share.kind} size={20} />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-[16px] font-semibold text-body">{share.fileName}</h1>
                  <p className="text-[12px] text-dim">
                    {formatBytes(share.sizeBytes)} · shared {timeAgo(share.createdAt)} · {share.downloads} downloads
                  </p>
                </div>
              </div>
              <a className="btn btn-primary" href={share.downloadUrl} download>
                <Download size={15} /> Download
              </a>
            </div>

            <div className="overflow-hidden rounded-2xl border border-line bg-panel">
              {share.kind === 'image' && (
                <img src={share.contentUrl} alt={share.fileName} className="mx-auto max-h-[70vh] w-auto object-contain" />
              )}
              {share.kind === 'video' && <video src={share.contentUrl} controls className="max-h-[70vh] w-full bg-black" />}
              {share.kind === 'audio' && (
                <div className="px-6 py-10 text-center">
                  <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-panel-2">
                    <FileIcon kind="audio" size={24} />
                  </div>
                  <audio src={share.contentUrl} controls className="mx-auto w-full max-w-md" />
                </div>
              )}
              {share.kind === 'pdf' && (
                <iframe src={share.contentUrl} title={share.fileName} className="h-[75vh] w-full bg-white" />
              )}
              {!['image', 'video', 'audio', 'pdf'].includes(share.kind) && (
                <div className="px-6 py-14 text-center">
                  <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-panel-2">
                    <FileIcon kind={share.kind} size={26} />
                  </div>
                  <p className="text-[13px] text-body">Preview is not available for this file type.</p>
                  <p className="mt-1 text-[12px] text-dim">Download it to open with the right app.</p>
                  <a className="btn btn-primary mt-5" href={share.downloadUrl} download>
                    <Download size={15} /> Download file
                  </a>
                </div>
              )}
            </div>

            <p className="mt-4 text-center text-[11px] text-faint">
              Served straight from {share.provider === 'google' ? 'Google Drive' : share.provider === 's3' ? 'an S3 bucket' : 'local storage'} by
              PSDrive{share.expiresAt ? ` · link expires ${new Date(share.expiresAt).toLocaleDateString()}` : ''}
            </p>
          </>
        )}
      </main>
    </div>
  )
}
