import { useEffect, useState } from 'react'
import { api, type Account, type ActivityItem, type PoolSummary } from './api'
import { on } from './bus'

export type Stats = {
  pool: PoolSummary
  accounts: Account[]
  counts: { files: number; folders: number; shares: number; trash: number; bytes: number }
  policy: { mode: string; order: string[] }
  activity: ActivityItem[]
  googleConfigured: boolean
  demoMode: boolean
  maxUploadBytes: number
}

export type FolderNode = {
  id: string
  name: string
  parentId: string | null
  color: string
  icon: string
}

/**
 * Shell data (pool + folders) is shared by the sidebar and several pages, so it
 * refreshes on a global event instead of being fetched three times per render.
 */
export function useShellData() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    Promise.all([api.get<Stats>('/api/stats'), api.get<{ folders: FolderNode[] }>('/api/folders/tree')])
      .then(([statsData, folderData]) => {
        setStats(statsData)
        setFolders(folderData.folders)
        setError(null)
      })
      .catch((err: Error) => setError(err.message))
  }

  useEffect(() => {
    load()
    const offRefresh = on('refresh', load)
    const offUpload = on('upload', load)
    return () => {
      offRefresh()
      offUpload()
    }
  }, [])

  return { stats, folders, error, reload: load, setStats }
}

export const FOLDER_COLORS: Record<string, string> = {
  indigo: '#818cf8',
  violet: '#a78bfa',
  blue: '#60a5fa',
  cyan: '#22d3ee',
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185',
  slate: '#94a3b8',
}

export const ACCOUNT_COLORS = ['#818cf8', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#a78bfa', '#60a5fa']

export function accountColor(index: number): string {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]
}
