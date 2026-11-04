# Architecture

PSDrive is one Node process with three jobs: serve an API, move bytes, and remember where they went.
This document explains the decisions behind that and where the sharp edges are.

---

## 1. Shape of the system

```
browser ──HTTP──► Hono app ──► SQLite (metadata)
                      │
                      └────────► provider ──► Google Drive / S3 / disk
                          (stream, never buffered)
```

There is no queue, no cache tier, no worker and no database server. For a self-hosted file manager those would
each add a failure mode and latency without adding capability. Concurrency is handled by Node's event loop plus
SQLite's WAL mode, which lets reads proceed while a write is in flight.

**Request path for a read:**

1. Hono middleware adds a request id, timing, security headers.
2. `requireUser` verifies the HS256 bearer token and loads the user row (single indexed lookup).
3. The handler runs one SQL statement through the cached prepared-statement layer.
4. The result is serialised, gzipped if it is over the threshold, and returned.

**Request path for an upload:**

1. `Content-Length` is read and validated *before* the body is touched.
2. The routing policy picks a destination account that can hold the whole file.
3. `pickAccount` → provider → `upload(stream)`. The request body is handed to the provider untouched.
4. On success a metadata row is written; on failure the partial object is cleaned up and nothing is recorded.

## 2. Why SQLite (and `node:sqlite`)

The access pattern is ~50–200 reads per write, single process, single tenant, and every query is
`WHERE user_id = ?` plus an index. A client/server database adds a network hop and a connection pool to solve
concurrency problems this app does not have. Measured cost of the listing query: **0.05 ms**.

`node:sqlite` is in Node 22's standard library. Choosing it over `better-sqlite3` removes a native compile step
from install, from CI, and from the Docker build — the single most common reason self-hosted Node apps fail to
build on someone else's machine.

Practical consequences:

- **WAL mode + `synchronous=NORMAL`** — commits are durable against process crashes, and reads never block.
- **Bind-count assertions** — the thin query wrapper fails loudly if a statement's placeholder count does not
  match the number of arguments. Without a type system for SQL, a missing argument silently binds `NULL` and the
  query "just" returns nothing; this turns that into an immediate, obvious error. (This bug was found by the
  integration tests and the guard now makes it impossible.)
- **Statement cache** — 500 statements, prepared once.
- **`PRAGMA foreign_keys=ON`** — deleting a user cascades; deleting an account does not silently orphan files.

Tradeoff: a single file. Writes serialise, so a pathological workload (thousands of concurrent uploads to one
instance) would bottleneck. At that point the answer is a second instance with a shared object store, not MySQL.

## 3. Streaming is the core invariant

The rule everywhere: **bytes move, memory does not grow with file size.**

| Path | How |
|---|---|
| Upload → local | `Readable.fromWeb(body).pipe(createWriteStream(tmp))` then atomic `rename` |
| Upload → S3 | signed `PUT` with the web stream as `body`, `duplex: 'half'`, explicit `Content-Length` |
| Upload → Google | open a resumable session, then `PUT` the stream with `Content-Length` |
| Download ← any | provider response body passed straight to the HTTP response |
| Range | `Range` header forwarded to the provider; `206` + `Content-Range` returned unchanged |

Measured: a 400 MB upload moved RSS from 101 MB → 124 MB (GC lag, not buffering), and 20 concurrent 8 MB range
reads added 1 MB. This is why `MAX_UPLOAD_BYTES` can be measured in gigabytes on a small VPS.

Two consequences worth knowing:

- **S3 cannot accept chunked PUTs.** An explicit `Content-Length` is mandatory, which is why the upload endpoint
  rejects requests without one (`400`) instead of starting a doomed transfer. The mock-bucket test asserts the
  header actually arrives.
- **`UNSIGNED-PAYLOAD`** is used for signing so the server never has to hash a gigabyte before forwarding it.
  It is valid for HTTPS requests and is accepted by AWS, R2, MinIO, Wasabi and B2. A plaintext HTTP endpoint
  should be avoided for that reason (and for the obvious one).

## 4. Upload routing

`pickAccount(userId, size)`:

1. Candidates = enabled accounts with a known free-space figure.
2. Discard accounts whose remaining space is smaller than this file. No partial writes, no failed transfers.
3. If nothing fits: `507 STORAGE_FULL`, including the total free space across the pool so the UI can explain it.
4. Otherwise order by policy:
   - `most_available` — largest free space wins; ties break on `priority`.
   - `round_robin` — stable order by creation time, cursor persisted in settings.
   - `priority` — first account in the user's explicit order that fits.

Free space comes from two places:

- **Google** reports real quota (`about.storageQuota`), cached for 5 minutes and refreshed in the background so
  the dashboard never blocks on a Google API call.
- **S3 / local** have no quota API, so usage is `SUM(size_bytes)` against the configured quota. This is exact the
  instant an upload finishes, because it comes from the same database that just recorded it.

## 5. Google OAuth and token lifecycle

- The browser leaves the app for consent, so it cannot carry a bearer token. The authenticated client first asks
  for a **signed, short-lived `state`** (900 s) containing the user id *and the redirect URI derived from the live
  request*. That makes the flow work on localhost, a custom domain or behind a proxy without editing `APP_URL`,
  and it makes token exchange use the exact same `redirect_uri` as the authorize request.
- Access tokens are cached **in memory** and refreshed by a **single-flight promise map**: ten parallel uploads to
  one account produce exactly one `POST /token`.
- Refresh tokens are encrypted at rest and reused on re-consent (Google only issues one on the first approval).
- The Drive folder id that holds uploads is resolved once per account and cached in the account's config JSON.

## 6. Authentication model

Two principals share the same handlers:

- **Browser** — short-lived HS256 access token (15 min) held in memory, plus an http-only refresh cookie
  (30 days) scoped to `/api/auth`. Refresh rotates the token and revokes the old session row, so a stolen
  cookie is single-use and revocable. The SPA restores a session on load by calling `/api/auth/refresh`.
- **API keys** — `X-API-Key`, SHA-256 hashed at rest, scope-checked per route, `last_used_at` tracked.

No access token is ever written to `localStorage`: an XSS bug can read memory, but it cannot persist across a
reload from storage.

Ownership is enforced in SQL, not in application logic: every query carries `user_id = ?`. There is no
"load then check" pattern to forget.

## 7. Search

An FTS5 external-content table mirrors `files.name`, kept in sync by insert/update/delete triggers — so search
costs nothing on the write path and stays correct even for bulk operations and cascades.

User input is tokenised and turned into a prefix query (`"inv"* "pdf"*`), which gives instant as-you-type
behaviour without exposing FTS5 syntax. If a query yields no usable tokens it falls back to `LIKE`.

## 8. Frontend

- **React 19 + Vite + Tailwind v4.** No component library, no state library, no router library — a 40-line
  History-API router and three React contexts (auth, toasts, uploads) cover the whole app.
- **Semantic CSS variables** for theming: switching light/dark is one class on `<html>`, not a thousand `dark:`
  variants, and the theme is applied before first paint to avoid a flash.
- **Uploads run in a context that lives above the router**, so navigating between pages does not cancel them.
  Three transfers run concurrently; the rest queue.
- **XHR rather than `fetch` for uploads** — `fetch` still cannot report upload progress.
- The production bundle is ~97 KB gzipped with immutable, gzip-served hashed assets.

## 9. Failure behaviour

| Situation | What happens |
|---|---|
| Provider rejects an upload | Partial object removed, no metadata row written, clear `502` with the provider message |
| Client disconnects mid-upload | Request signal aborts the pipeline, temp file cleaned up, logged at debug |
| Google token expired | Refreshed once, transparently, then the request proceeds |
| Google token refresh fails | Account flagged with `last_error`, surfaced on the Accounts page |
| No account can hold the file | `507` with total free space, before any bytes move |
| Purge fails upstream | The object is dropped from the index anyway; the row is not left half-deleted |
| Account disconnected | Its files leave the index; **nothing is deleted from the provider** |

## 10. Known limits

- Files > 5 GB on S3 need multipart uploads; the current provider uses a single signed PUT.
- Interrupted uploads restart from zero (Google resumable sessions are opened per request).
- Virtual folders are PSDrive's own concept; files sit in the provider's `PSDrive` root folder rather than in
  matching provider-side folders. That keeps moves and renames instant and provider-agnostic.
- One process, one SQLite file — scale up by giving it more disk, not more replicas.
- No background sync of files added directly inside Google Drive (listed on the roadmap).

These are deliberate: each would add meaningful complexity for a self-hosted single-user drive, and each is
listed so nobody discovers it the hard way.
