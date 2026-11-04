import { useState } from 'react'
import { AlertCircle, Check, ChevronDown, CloudUpload, RotateCw, X } from 'lucide-react'
import { useUploads } from '../lib/app-context'
import { formatBytes, formatSpeed } from '../lib/format'
import { Progress, Spinner } from './ui'

export function UploadTray() {
  const { tasks, activeCount, cancel, retry, dismiss, clearFinished } = useUploads()
  const [collapsed, setCollapsed] = useState(false)

  if (tasks.length === 0) return null

  const done = tasks.filter((task) => task.status === 'done').length
  const failed = tasks.filter((task) => task.status === 'error').length

  return (
    <div className="pointer-events-none fixed right-0 bottom-0 z-40 w-full max-w-[380px] px-3 pb-3 sm:right-3">
      <div className="animate-slide-up pointer-events-auto overflow-hidden rounded-xl border border-line bg-elevated shadow-panel">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
            {activeCount > 0 ? <Spinner size={14} /> : failed > 0 ? <AlertCircle size={14} /> : <Check size={14} />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-body">
              {activeCount > 0 ? `Uploading ${activeCount} file${activeCount > 1 ? 's' : ''}` : failed > 0 ? `${failed} failed` : `${done} uploaded`}
            </p>
          </div>
          <button
            className="rounded p-1 text-faint transition hover:text-body"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
          >
            <ChevronDown size={15} className={collapsed ? 'rotate-180 transition-transform' : 'transition-transform'} />
          </button>
          {activeCount === 0 && (
            <button className="rounded p-1 text-faint transition hover:text-body" onClick={clearFinished} aria-label="Dismiss uploads">
              <X size={15} />
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="max-h-[264px] overflow-y-auto p-1.5">
            {tasks.map((task) => {
              const pct = task.size > 0 ? (task.loaded / task.size) * 100 : 0
              const elapsed = task.startedAt ? (Date.now() - task.startedAt) / 1000 : 0
              const speed = elapsed > 0.4 ? task.loaded / elapsed : 0
              const remaining = speed > 0 ? (task.size - task.loaded) / speed : 0

              return (
                <div key={task.id} className="rounded-lg px-1.5 py-1.5 transition hover:bg-panel-2">
                  <div className="flex items-center gap-2">
                    <CloudUpload
                      size={14}
                      className={task.status === 'error' ? 'text-danger' : task.status === 'done' ? 'text-success' : 'text-faint'}
                      style={task.status === 'done' ? { color: 'var(--success)' } : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-body" title={task.name}>
                      {task.name}
                    </span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
                      {task.status === 'uploading'
                        ? `${formatBytes(task.loaded)} / ${formatBytes(task.size)}`
                        : task.status === 'done'
                          ? formatBytes(task.size)
                          : task.status === 'queued'
                            ? 'Queued'
                            : ''}
                    </span>
                    {task.status === 'uploading' || task.status === 'queued' ? (
                      <button className="rounded p-0.5 text-faint hover:text-danger" onClick={() => cancel(task.id)} aria-label="Cancel upload">
                        <X size={13} />
                      </button>
                    ) : task.status === 'error' ? (
                      <>
                        <button className="rounded p-0.5 text-faint hover:text-body" onClick={() => retry(task.id)} aria-label="Retry upload">
                          <RotateCw size={12} />
                        </button>
                        <button className="rounded p-0.5 text-faint hover:text-body" onClick={() => dismiss(task.id)} aria-label="Dismiss">
                          <X size={13} />
                        </button>
                      </>
                    ) : (
                      <button className="rounded p-0.5 text-faint hover:text-body" onClick={() => dismiss(task.id)} aria-label="Dismiss">
                        <X size={13} />
                      </button>
                    )}
                  </div>

                  {(task.status === 'uploading' || task.status === 'queued') && (
                    <>
                      <Progress value={pct} height={3} className="mt-1.5" />
                      <div className="mt-1 flex justify-between text-[10px] text-faint">
                        <span>{pct.toFixed(0)}%</span>
                        <span>
                          {speed > 0 ? formatSpeed(speed) : '—'}
                          {remaining > 1 && speed > 0 ? ` · ${Math.ceil(remaining)}s left` : ''}
                        </span>
                      </div>
                    </>
                  )}

                  {task.status === 'error' && <p className="mt-1 truncate text-[10.5px] text-danger">{task.error}</p>}
                  {task.status === 'done' && task.accountLabel && (
                    <p className="mt-0.5 text-[10px] text-faint">stored on {task.accountLabel}</p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
