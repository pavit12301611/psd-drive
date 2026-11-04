import {
  Archive,
  Code2,
  File,
  FileSpreadsheet,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { extOf } from '../lib/format'

const MAP: Record<string, { icon: LucideIcon; color: string; bg: string }> = {
  image: { icon: ImageIcon, color: '#a78bfa', bg: 'rgba(167,139,250,0.14)' },
  video: { icon: Film, color: '#fb7185', bg: 'rgba(251,113,133,0.14)' },
  audio: { icon: Music, color: '#fbbf24', bg: 'rgba(251,191,36,0.14)' },
  pdf: { icon: FileText, color: '#f87171', bg: 'rgba(248,113,113,0.14)' },
  doc: { icon: FileText, color: '#60a5fa', bg: 'rgba(96,165,250,0.14)' },
  sheet: { icon: FileSpreadsheet, color: '#34d399', bg: 'rgba(52,211,153,0.14)' },
  slide: { icon: Presentation, color: '#fb923c', bg: 'rgba(251,146,60,0.14)' },
  archive: { icon: Archive, color: '#fbbf24', bg: 'rgba(251,191,36,0.14)' },
  code: { icon: Code2, color: '#22d3ee', bg: 'rgba(34,211,238,0.14)' },
  text: { icon: FileText, color: '#94a3b8', bg: 'rgba(148,163,184,0.14)' },
  folder: { icon: File, color: '#818cf8', bg: 'rgba(129,140,248,0.14)' },
  other: { icon: File, color: '#94a3b8', bg: 'rgba(148,163,184,0.14)' },
}

export function fileVisual(kind: string) {
  return MAP[kind] ?? MAP.other
}

export function FileIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const visual = fileVisual(kind)
  const Icon = visual.icon
  return <Icon size={size} style={{ color: visual.color }} strokeWidth={1.9} />
}

/** Square tinted tile used in grids and lists. */
export function FileTile({ kind, size = 40, label }: { kind: string; size?: number; label?: string }) {
  const visual = fileVisual(kind)
  const Icon = visual.icon
  return (
    <span
      className="relative flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size, background: visual.bg, color: visual.color }}
    >
      <Icon size={size * 0.46} strokeWidth={1.9} />
      {label && (
        <span
          className="absolute -bottom-1 rounded px-1 text-[7px] font-bold tracking-wide"
          style={{ background: 'var(--panel)', color: visual.color, fontSize: Math.max(7, size * 0.17) }}
        >
          {label}
        </span>
      )}
    </span>
  )
}

export function extLabel(name: string): string {
  const ext = extOf(name)
  return ext.length > 4 ? ext.slice(0, 4) : ext
}
