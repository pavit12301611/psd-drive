import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react'
import { contentUrl, downloadUrl, hasAccessToken, restoreSession, type FileItem } from '../lib/api'
import { formatBytes } from '../lib/format'
import { FileIcon } from './file-icon'
import { Spinner } from './ui'

/**
 * Inline viewer for images, video, audio, PDF and text.
 *
 * Media is streamed from the API with Range support, so scrubbing a video does
 * not re-download the file and a PDF renders progressively.
 */
export function PreviewModal({
  file,
  onClose,
  onPrev,
  onNext,
}: {
  file: FileItem | null
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [loadingText, setLoadingText] = useState(false)

  useEffect(() => {
    if (!file) return
    setText(null)
    if (file.kind !== 'text' && file.kind !== 'code' && file.kind !== 'sheet') return

    let cancelled = false
    setLoadingText(true)
    ;(async () => {
      try {
        if (!hasAccessToken()) await restoreSession()
        const res = await fetch(contentUrl(file.id))
        const body = await res.text()
        // Guard against opening a binary as text.
        if (!cancelled) setText(body.slice(0, 200_000))
      } catch {
        if (!cancelled) setText('Could not load this file.')
      } finally {
        if (!cancelled) setLoadingText(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [file])

  useEffect(() => {
    if (!file) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onPrev?.()
      if (event.key === 'ArrowRight') onNext?.()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [file, onClose, onPrev, onNext])

  if (!file) return null

  const src = `${contentUrl(file.id)}${file.kind === 'text' ? '' : ''}`

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <FileIcon kind={file.kind} size={18} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-white">{file.name}</p>
          <p className="text-[11px] text-white/55">
            {formatBytes(file.sizeBytes)} · {file.accountLabel}
          </p>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
          title="Open in new tab"
        >
          <ExternalLink size={16} />
        </a>
        <a
          href={downloadUrl(file.id)}
          className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white"
          title="Download"
        >
          <Download size={16} />
        </a>
        <button className="rounded-lg p-2 text-white/70 transition hover:bg-white/10 hover:text-white" onClick={onClose} aria-label="Close preview">
          <X size={18} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-4 sm:px-14">
        {onPrev && (
          <button
            onClick={onPrev}
            className="absolute left-1 z-10 rounded-full bg-white/10 p-2 text-white/80 transition hover:bg-white/20 hover:text-white sm:left-3"
            aria-label="Previous file"
          >
            <ChevronLeft size={20} />
          </button>
        )}
        {onNext && (
          <button
            onClick={onNext}
            className="absolute right-1 z-10 rounded-full bg-white/10 p-2 text-white/80 transition hover:bg-white/20 hover:text-white sm:right-3"
            aria-label="Next file"
          >
            <ChevronRight size={20} />
          </button>
        )}

        {file.kind === 'image' && (
          <img src={src} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        )}

        {file.kind === 'video' && (
          <video src={src} controls autoPlay className="max-h-full max-w-full rounded-lg bg-black shadow-2xl" />
        )}

        {file.kind === 'audio' && (
          <div className="w-full max-w-md rounded-2xl bg-white/5 p-6 text-center">
            <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-white/10">
              <FileIcon kind="audio" size={28} />
            </div>
            <p className="mb-4 truncate text-sm text-white">{file.name}</p>
            <audio src={src} controls autoPlay className="w-full" />
          </div>
        )}

        {file.kind === 'pdf' && (
          <iframe src={src} title={file.name} className="h-full w-full max-w-4xl rounded-lg bg-white" />
        )}

        {(file.kind === 'text' || file.kind === 'code' || file.kind === 'sheet') && (
          <div className="h-full w-full max-w-4xl overflow-auto rounded-lg border border-white/10 bg-[#0b0f17]">
            {loadingText ? (
              <div className="flex h-full items-center justify-center text-white/50">
                <Spinner size={18} />
              </div>
            ) : (
              <pre className="p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-white/85">{text}</pre>
            )}
          </div>
        )}

        {!file.previewable && (
          <div className="max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
            <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-white/10">
              <FileIcon kind={file.kind} size={26} />
            </div>
            <p className="text-sm text-white">No preview for this file type</p>
            <p className="mt-1 text-xs text-white/50">Download it to open with the right app.</p>
            <a href={downloadUrl(file.id)} className="btn btn-primary mt-4">
              <Download size={15} /> Download
            </a>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
