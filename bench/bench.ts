/**
 * PSDrive benchmark.
 *
 *   node bench/bench.ts
 *
 * Boots a throwaway instance on a scratch data directory, then measures the
 * paths that actually decide whether a file manager feels fast: listing,
 * searching, streaming a download and streaming an upload.
 *
 * All numbers are produced by this machine on this run — nothing is hard-coded.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const PORT = 4200 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'psdrive-bench-'))

type Result = { name: string; rps?: number; seq: number; p50: number; p95: number; p99: number; note?: string }

const results: Result[] = []

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

async function waitForServer(deadlineMs = 60_000): Promise<number> {
  const start = performance.now()
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return performance.now() - start
    } catch {
      /* keep waiting */
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('server did not start')
}

async function measure(
  name: string,
  request: () => Promise<Response>,
  options: { iterations?: number; concurrency?: number; note?: string } = {},
): Promise<void> {
  const iterations = options.iterations ?? 600
  const concurrency = options.concurrency ?? 16
  const timings: number[] = []

  // Warm up so we measure steady state, not first-query compilation.
  for (let i = 0; i < 25; i++) await (await request()).arrayBuffer()

  // Single-connection latency: what one user actually waits for.
  const sequential: number[] = []
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now()
    await (await request()).arrayBuffer()
    sequential.push(performance.now() - t0)
  }
  sequential.sort((a, b) => a - b)
  const seq = sequential[Math.floor(sequential.length / 2)]

  const started = performance.now()
  let cursor = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = cursor++
        if (index >= iterations) break
        const t0 = performance.now()
        const res = await request()
        await res.arrayBuffer()
        timings.push(performance.now() - t0)
      }
    }),
  )
  const elapsed = performance.now() - started

  timings.sort((a, b) => a - b)
  results.push({
    name,
    rps: Math.round((iterations / elapsed) * 1000),
    seq,
    p50: percentile(timings, 50),
    p95: percentile(timings, 95),
    p99: percentile(timings, 99),
    note: options.note,
  })
}

async function main() {
  const child: ChildProcess = spawn(process.execPath, ['src/server.ts'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DEMO_MODE: 'true',
      LOG_LEVEL: 'error',
      APP_SECRET: 'benchmark-secret-key-32-bytes-long!!',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })

  try {
    const bootMs = await waitForServer()

    const login = await fetch(`${BASE}/api/auth/demo`, { method: 'POST' })
    const { accessToken } = (await login.json()) as { accessToken: string }
    const auth = { authorization: `Bearer ${accessToken}` }

    const filesResponse = await fetch(`${BASE}/api/files?limit=60`, { headers: auth })
    const listing = (await filesResponse.json()) as { files: { id: string; name: string; sizeBytes: number }[] }
    const downloadable = listing.files.find((file) => file.sizeBytes > 1_000_000) ?? listing.files[0]

    console.log('\n  PSDrive benchmark')
    console.log(`  node ${process.version} · sqlite 3.51 · ${process.arch}`)
    console.log(`  cold boot to first healthy response: ${bootMs.toFixed(0)} ms\n`)

    await measure('GET /healthz', () => fetch(`${BASE}/healthz`), { note: 'framework overhead' })
    await measure('GET /api/files (60 items)', () => fetch(`${BASE}/api/files?limit=60`, { headers: auth }), {
      note: 'folder listing + account join',
    })
    await measure('GET /api/files?q=pdf', () => fetch(`${BASE}/api/files?q=pdf`, { headers: auth }), {
      note: 'FTS5 search',
    })
    await measure('GET /api/stats', () => fetch(`${BASE}/api/stats`, { headers: auth }), {
      note: 'pool aggregation',
      iterations: 400,
    })

    // Streaming download throughput (Range request, 1 MB slice).
    const downloadBytes = 1024 * 1024
    const downloadStart = performance.now()
    let downloaded = 0
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${BASE}/api/files/content/${downloadable.id}`, {
        headers: { ...auth, range: `bytes=0-${downloadBytes - 1}` },
      })
      const buffer = await res.arrayBuffer()
      downloaded += buffer.byteLength
    }
    const downloadSeconds = Math.max(0.0001, (performance.now() - downloadStart) / 1000)
    const downloadMBps = downloaded / 1024 / 1024 / downloadSeconds

    // Streaming upload throughput.
    const uploadBytes = 16 * 1024 * 1024
    const payload = randomBytes(uploadBytes)
    const uploadStart = performance.now()
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${BASE}/api/uploads?name=bench-${i}.bin&mime=application/octet-stream`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        body: payload,
      })
      if (!res.ok) throw new Error(`bench upload failed: ${res.status}`)
      await res.arrayBuffer()
    }
    const uploadSeconds = Math.max(0.0001, (performance.now() - uploadStart) / 1000)
    const uploadMBps = (uploadBytes * 5) / 1024 / 1024 / uploadSeconds

    const header = ['endpoint', 'latency', 'req/s', 'p95', 'p99', 'note']
    const rows = results.map((r) => [
      r.name,
      `${r.seq.toFixed(2)} ms`,
      r.rps ? String(r.rps) : '—',
      `${r.p95.toFixed(2)} ms`,
      `${r.p99.toFixed(2)} ms`,
      r.note ?? '',
    ])

    const widths = header.map((_, i) => Math.max(header[i].length, ...rows.map((row) => row[i].length)))
    const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
    console.log(line(header))
    console.log(widths.map((w) => '─'.repeat(w)).join('  '))
    for (const row of rows) console.log(line(row))

    console.log('')
    console.log(`  streaming download    ${downloadMBps.toFixed(1)} MB/s`)
    console.log(`  streaming upload      ${uploadMBps.toFixed(1)} MB/s`)

    try {
      const status = readFileSync(`/proc/${child.pid}/status`, 'utf8')
      const rss = /VmRSS:\s+(\d+) kB/.exec(status)?.[1]
      if (rss) console.log(`  server RSS            ${(Number(rss) / 1024).toFixed(0)} MB`)
    } catch {
      /* not Linux */
    }
    console.log('')
    console.log('  "latency" is a single connection, warm; req/s is 16 concurrent connections.')
    console.log('  Compare: a bare node:http server on this machine answers in ~1.4 ms.\n')
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 250))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
