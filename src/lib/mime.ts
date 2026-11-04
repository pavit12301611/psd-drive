export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'doc' | 'sheet' | 'slide' | 'archive' | 'code' | 'text' | 'folder' | 'other'

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

export function guessMime(name: string, fallback = 'application/octet-stream'): string {
  return EXT_MIME[extensionOf(name)] ?? fallback
}

export function kindOf(mimeType: string, name = ''): FileKind {
  const mime = mimeType || guessMime(name)
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.includes('spreadsheet') || mime === 'text/csv' || mime.includes('ms-excel')) return 'sheet'
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'slide'
  if (mime.includes('word') || mime.includes('opendocument.text')) return 'doc'
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('7z') || mime.includes('gzip')) return 'archive'
  if (/^(text|application)\/(javascript|typescript|json|xml|x-yaml|yaml)/.test(mime)) return 'code'
  if (mime.startsWith('text/')) return 'text'
  return 'other'
}

export function isPreviewable(mimeType: string, name = ''): boolean {
  const kind = kindOf(mimeType, name)
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf' || kind === 'text' || kind === 'code' || kind === 'sheet'
}

/** Browser-safe inline types; anything else is served as a download. */
export function inlineMime(mimeType: string, name: string): string {
  const kind = kindOf(mimeType, name)
  if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') return mimeType
  if (kind === 'text' || kind === 'code' || kind === 'sheet') return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 200).trim() || 'untitled'
}
