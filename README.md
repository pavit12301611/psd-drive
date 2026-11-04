# PSDrive

**One drive for every cloud.**

PSDrive pools multiple Google Drive accounts (plus any S3-compatible bucket and local disk) into a single,
fast, self-hosted file manager. Uploads are routed automatically to whichever account still has room, and
every byte is streamed straight through the server — never buffered, never written to temp disk.

Rebuilt from scratch as a faster, smaller take on [9drive](https://github.com/zenhosta/9drive).

```
        ┌──────────────┐
        │   you@1      │ 15 GB   ┐
        ├──────────────┤         │
        │   you@2      │ 15 GB   ├──►  ┌───────────────┐  ──► one file manager
        ├──────────────┤         │     │    PSDrive    │      one storage pool
        │  R2 bucket   │ ∞       │     │  (one process)│      one set of share links
        ├──────────────┤         │     └───────────────┘
        │  local disk  │ 2 TB    ┘
        └──────────────┘
```

---

## Why this build is fast

Every number below was measured on a 2-core sandbox with `npm run bench` and real 400 MB transfers.
Nothing here is a guess.

| | Measured |
|---|---|
| Cold boot to first healthy response | **~0.36 s** (DB migrations included) |
| Folder listing (60 files, 16 concurrent) | **1.8 ms** latency · **888 req/s** |
| Full-text search (FTS5) | **2.2 ms** latency |
| Storage-pool aggregation | **1.4 ms** latency |
| The same listing query, straight SQLite | **0.05 ms** |
| Streaming download | **196 MB/s** (641 MB/s large-file) |
| Streaming upload | **188 MB/s** |
| 400 MB upload → memory growth | **+22 MB** (then flat) |
| 20 concurrent 8 MB range reads → memory growth | **+1 MB** |
| JS bundle | **97 KB gzipped** |

The architecture that produces those numbers:

- **Zero native dependencies.** `node:sqlite` ships with Node 22, so there is no `better-sqlite3` build step,
  no `argon2` compile, no `prisma generate`. `npm ci` takes seconds and works on any machine.
- **Three runtime dependencies.** `hono`, `zod`, `@hono/node-server`. The AWS SDK is replaced by ~200 lines of
  SigV4 ([verified against the official AWS test vectors](test/sigv4.test.ts)) that stream payloads instead of
  hashing them first.
- **No build step for the server.** Node 22 strips TypeScript types natively, so `node src/server.ts` *is* the
  production start command.
- **SQLite in WAL mode instead of a database server.** No TCP hop, no connection pool, no ORM hydration:
  listing a folder is a single index scan costing 50 µs.
- **Pure stream passthrough.** Uploads flow browser → PSDrive → provider and downloads flow back the other way.
  Memory is O(1) in file size, which is why a 400 MB upload costs 22 MB of RSS rather than 400 MB.
- **Range requests end to end.** Video scrubbing and PDF paging hit the provider with `Range:` and return `206`
  with a correct `Content-Range`; nothing is downloaded twice.
- **One process, one port.** The API and the built SPA are served together with immutable asset caching and gzip.

## Features

**Storage**
- Google Drive, S3-compatible buckets (AWS, R2, MinIO, Wasabi, B2, Spaces) and local disk in one pool.
- Combined quota meter with per-account breakdown.
- Upload routing: *most free space*, *round-robin*, or *priority order* — with a hard guarantee that a file only
  goes to an account that can hold the whole thing (and a clean `507` when nothing can).
- Google uploads land in a `PSDrive` folder inside that account's Drive.

**Files**
- Nested folders with colours and icons, list and grid views, drag-and-drop uploads.
- Streaming uploads with a progress tray: live speed, ETA, cancel/retry, three concurrent transfers.
- Instant search powered by SQLite FTS5 (index-maintained by triggers).
- Sort by name/size/modified, cursor-free pagination, multi-select with shift-click, right-click menus.
- Preview images, video, audio, PDF and text inline with keyboard navigation.
- Rename, move, star, trash, restore, purge, empty trash.

**Sharing**
- Public links with a standalone viewer page, view/download counters, optional expiry and instant revoke.

**For developers**
- API keys (shown once, stored hashed, scoped to `upload`/`read`/`delete`, with last-used tracking).
- `POST /api/v1/files?name=...` streaming upload, list, download and delete endpoints.
- Copy-paste cURL snippets generated from your own instance URL.

**Operations**
- Single container, single data directory, `GET /healthz`.
- AES-256-GCM encryption for provider credentials and OAuth tokens.
- Graceful shutdown, structured logs, per-request IDs, rate limiting on auth and public endpoints.

## Quick start

### Docker (recommended)

```bash
git clone <this repo> psdrive && cd psdrive
docker compose up -d --build
```

Open **http://localhost:3000**. That is the whole setup — no database container, no migrations to run,
no `.env` to fill in.

### Local

Requires **Node 22.18+** (for native TypeScript and `node:sqlite`). Nothing else.

```bash
npm install
npm run build      # builds the SPA into dist/ (~2 s)
npm start          # http://localhost:3000
```

For development with hot reload:

```bash
npm run dev        # API on :3000, restarts on change
npm run dev:web    # Vite on :5173, proxies /api to :3000
```

### First run

`DEMO_MODE=true` (the default) creates a ready-to-explore workspace:

- **demo@psdrive.local** / **demo1234**, or just press **“Explore the demo workspace”**
- three accounts (two 15 GB, one deliberately 92% full), six folders, real photos, PDFs, notes and backups
- a live share link and an activity history

Create your own account with **Sign up**; a fresh account starts empty and walks you into
*Accounts → Connect Google Drive*.

## Connecting storage

### Google Drive

1. In [Google Cloud Console](https://console.cloud.google.com/), create an OAuth client (type: *Web application*)
   and enable the **Google Drive API**.
2. Add the authorized redirect URI shown in **Settings → Google Drive credentials**
   (defaults to `http://localhost:3000/api/oauth/google/callback`).
3. Paste the client ID and secret into **Settings**, or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. **Accounts → Connect Google Drive** once per account you want to pool. Use *“use another account”* in the
   Google chooser to add more than one.

Access tokens are refreshed with single-flight de-duplication, so ten parallel uploads trigger one refresh.

### S3-compatible

**Accounts → S3 bucket.** Credentials are validated with a signed `HEAD` before anything is saved.

| Provider | Endpoint | Region | Path-style |
|---|---|---|---|
| AWS S3 | *(empty)* | e.g. `ap-south-1` | off |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | `auto` | off |
| MinIO | `https://minio.example.com:9000` | any | on |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | e.g. `us-west-004` | off |
| Wasabi | `https://s3.<region>.wasabisys.com` | e.g. `ap-southeast-1` | off |

Optionally set a quota in GB — S3 has no quota API, so PSDrive tracks usage against that budget.

### Local disk

**Accounts → Local disk.** Useful for a NAS mount or a fast tier. Leave the quota empty to report the real free
space of the volume.

## Configuration

All configuration is environment based and fully optional. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | SQLite database + blobs |
| `APP_URL` | `http://localhost:3000` | Public URL for links that leave the app |
| `APP_SECRET` | auto-generated | AES key; stored in `DATA_DIR/secret.key` if unset |
| `DEMO_MODE` | `true` | Seed/keep the demo workspace |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `MAX_UPLOAD_BYTES` | 8 GiB | Per-file upload limit |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth app |
| `TRUST_PROXY` | `true` | Honour `X-Forwarded-*` |

### Backing up

Everything lives in `DATA_DIR`:

```
data/
├── psdrive.db          SQLite database (WAL: also -wal / -shm)
├── secret.key          encryption key for provider credentials
└── blobs/<account>/    files stored on the local provider
```

Copy that folder (or the Docker volume) while the app is stopped — or use
`sqlite3 data/psdrive.db ".backup data/backup.db"` while it runs. **Keep `secret.key`**: without it, stored
provider credentials cannot be decrypted.

## HTTP API

Create a key in **API keys** (scopes: `upload`, `read`, `delete`).

```bash
# Upload a file — it lands on whichever account has room
curl -X POST "$PSDRIVE/api/v1/files?name=backup.tar.gz" \
  -H "X-API-Key: psd_..." \
  -H "Content-Type: application/gzip" \
  --data-binary @backup.tar.gz

# What is in the pool?
curl "$PSDRIVE/api/v1/usage" -H "X-API-Key: psd_..."

# Get it back (supports Range)
curl "$PSDRIVE/api/v1/files/<id>/download" -H "X-API-Key: psd_..." -o backup.tar.gz
```

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/files?name=<file>` | `upload` | Stream a file into the pool |
| `GET` | `/api/v1/files` | `read` | List files |
| `GET` | `/api/v1/files/:id/download` | `read` | Download (Range supported) |
| `DELETE` | `/api/v1/files/:id` | `delete` | Delete permanently |
| `GET` | `/api/v1/usage` | `read` | Pool + per-account usage |

The session API used by the web app lives under `/api/*` and authenticates with a short-lived bearer token
plus a rotating http-only refresh cookie.

## How it works

```
web/            React 19 SPA — Vite, Tailwind v4, ~97 KB gzipped, no router dependency
src/
├── app.ts            Hono app: middleware, routes, static SPA, error handling
├── server.ts         boot: migrate → seed demo → serve → graceful shutdown
├── db/               node:sqlite wrapper (statement cache + bind assertions) & migrations
├── lib/              crypto, jwt, sigv4, mime, rate limiting, logging
├── providers/        local · s3 · google — one tiny interface
├── services/         accounts, quota, routing, google-auth, activity, demo seeding
└── routes/           auth, files, folders, uploads, shares, accounts, api-keys, v1
```

Adding a backend means implementing one interface:

```ts
interface StorageProvider {
  upload(input: { body: ReadableStream; size: number; name: string; mimeType: string }): Promise<StoredObject>
  download(id: string, range?: { start: number; end?: number }): Promise<DownloadResult>
  remove(id: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  quota(): Promise<{ total: number | null; used: number; available: number | null }>
}
```

More detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```bash
npm test          # 38 tests: SigV4 vectors, crypto, ranges, PDF, S3 provider, and full-stack API
npm run bench     # the benchmark table above
npm run typecheck # strict TypeScript over server + web
```

The test suite boots a real server on a scratch data directory and drives it over HTTP — uploads, ranges,
sharing, API keys, routing, trash and session rotation — plus a mock S3 bucket that proves streamed requests
carry a `Content-Length` and that `Range` is forwarded correctly.

## Security notes

- Provider credentials and OAuth tokens are encrypted at rest with AES-256-GCM.
- Passwords use scrypt (N=16384) with per-user salts; API keys and refresh tokens are stored as SHA-256 hashes.
- Refresh tokens rotate on every use, live in an http-only cookie scoped to `/api/auth`, and are revocable.
- Every file, folder, account, share and key lookup is scoped by `user_id` in SQL — there is no “check then fetch”.
- Strict CSP, `nosniff`, `frame-ancestors 'self'`, and text previews are always served as `text/plain`.
- Rate limits on login, registration, demo entry and public share endpoints.
- Disconnecting an account removes it from PSDrive but **never** deletes files from the provider itself.

Found a security issue? Please open a private advisory rather than a public issue.

## Roadmap

- [ ] Resumable multi-part uploads for connections that keep dying mid-file
- [ ] Sync changes made directly inside Google Drive (import external files into the index)
- [ ] OneDrive / Dropbox providers (the interface above is all it takes)
- [ ] Folder-level sharing with invited collaborators
- [ ] Background jobs for large moves between accounts

## License

[Apache-2.0](LICENSE).

Inspired by [zenhosta/9drive](https://github.com/zenhosta/9drive) — same idea (one drive for every cloud),
rebuilt for speed and a much smaller footprint. Not affiliated with Google.
