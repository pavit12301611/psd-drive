import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decrypt, encrypt, hashPassword, safeEqual, signPayload, verifyPayload, verifyPassword } from '../src/lib/crypto.ts'
import { signAccessToken, verifyAccessToken } from '../src/lib/jwt.ts'
import { buildPdf } from '../src/services/demo.ts'
import { guessMime, inlineMime, isPreviewable, kindOf, sanitizeFilename } from '../src/lib/mime.ts'
import { parseRange } from '../src/routes/files.ts'

test('credentials round-trip through AES-256-GCM', () => {
  const secret = 'ya29.a0AfH6SMB-google-refresh-token'
  const sealed = encrypt(secret)
  assert.notEqual(sealed, secret)
  assert.match(sealed, /^v1\./)
  assert.equal(decrypt(sealed), secret)

  // Distinct IV every time.
  assert.notEqual(encrypt(secret), encrypt(secret))
})

test('tampered ciphertext is rejected, not silently decrypted', () => {
  const sealed = encrypt('top-secret')
  const parts = sealed.split('.')
  const bytes = Buffer.from(parts[2], 'base64url')
  bytes[0] ^= 0xff
  parts[2] = bytes.toString('base64url')
  assert.throws(() => decrypt(parts.join('.')))
})

test('password hashing verifies correctly and rejects wrong passwords', () => {
  const hash = hashPassword('correct horse battery staple')
  assert.match(hash, /^scrypt\$/)
  assert.equal(verifyPassword('correct horse battery staple', hash), true)
  assert.equal(verifyPassword('wrong password', hash), false)
  assert.equal(verifyPassword('', hash), false)
  assert.equal(verifyPassword('anything', 'garbage'), false)
})

test('access tokens are signed and verified', () => {
  const token = signAccessToken({ id: 'user-1', email: 'a@b.com', name: 'Ada' })
  const claims = verifyAccessToken(token)
  assert.ok(claims)
  assert.equal(claims.sub, 'user-1')
  assert.equal(claims.email, 'a@b.com')
  assert.ok(claims.exp > claims.iat)

  // Any single-character change must invalidate the signature.
  const [h, p, s] = token.split('.')
  const flipped = `${h}.${p}.${s.slice(0, -1)}${s.at(-1) === 'A' ? 'B' : 'A'}`
  assert.equal(verifyAccessToken(flipped), null)
  assert.equal(verifyAccessToken('not-a-token'), null)
})

test('signed payloads expire', () => {
  const valid = signPayload({ userId: 'u1' }, 60)
  assert.equal(verifyPayload<{ userId: string }>(valid)?.userId, 'u1')

  const expired = signPayload({ userId: 'u1' }, -1)
  assert.equal(verifyPayload(expired), null)

  const [raw] = valid.split('.')
  assert.equal(verifyPayload(`${raw}.forgedsignature`), null)
})

test('safeEqual compares without leaking length', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcdef'), false)
})

test('file kinds, preview eligibility and name sanitising', () => {
  assert.equal(kindOf('image/jpeg'), 'image')
  assert.equal(kindOf('', 'clip.mp4'), 'video')
  assert.equal(kindOf('application/pdf'), 'pdf')
  assert.equal(kindOf('text/csv'), 'sheet')
  assert.equal(kindOf('application/zip'), 'archive')
  assert.equal(kindOf('text/plain', 'notes.md'), 'text')
  assert.equal(kindOf('application/octet-stream', 'blob'), 'other')

  assert.equal(isPreviewable('image/png'), true)
  assert.equal(isPreviewable('application/zip'), false)

  // Text previews must never be served as HTML.
  assert.equal(inlineMime('text/html', 'x.html'), 'text/plain; charset=utf-8')
  assert.equal(inlineMime('image/png', 'x.png'), 'image/png')

  assert.equal(sanitizeFilename('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(sanitizeFilename('a/b\\c:d*.txt'), 'a_b_c_d_.txt')
  assert.equal(sanitizeFilename('   '), 'untitled')
  assert.equal(sanitizeFilename('..hidden'), 'hidden')
})

test('range parsing handles normal, open, suffix and invalid ranges', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=50-1000', 100), { start: 50, end: 99 })
  assert.equal(parseRange('bytes=100-', 100), 'invalid')
  assert.equal(parseRange('bytes=50-10', 100), 'invalid')
  assert.equal(parseRange('items=0-9', 100), 'invalid')
})

test('the demo PDF has valid xref offsets', () => {
  const bytes = buildPdf('Test title', ['line one', 'line two (with parens)'])
  const text = new TextDecoder('latin1').decode(bytes)

  assert.ok(text.startsWith('%PDF-1.4'))
  assert.ok(text.trimEnd().endsWith('%%EOF'))

  const xrefStart = Number(/startxref\n(\d+)/.exec(text)![1])
  assert.equal(text.slice(xrefStart, xrefStart + 4), 'xref')

  // Every offset in the table must land exactly on "N 0 obj".
  const entries = text.slice(xrefStart).split('\n').filter((line) => /^\d{10} \d{5} n\s?$/.test(line))
  assert.equal(entries.length, 5)
  entries.forEach((entry, index) => {
    const offset = Number(entry.slice(0, 10))
    assert.equal(text.slice(offset, offset + `${index + 1} 0 obj`.length), `${index + 1} 0 obj`)
  })
})

test('mime guessing covers the common extensions', () => {
  assert.equal(guessMime('a.jpg'), 'image/jpeg')
  assert.equal(guessMime('a.JPEG'), 'image/jpeg')
  assert.equal(guessMime('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(guessMime('noextension'), 'application/octet-stream')
})
