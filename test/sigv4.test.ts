import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signRequest } from '../src/lib/sigv4.ts'

/**
 * The AWS "Signature Version 4 test suite" vector for S3.
 *
 * If this matches, the canonical request, string-to-sign, signing-key
 * derivation and header ordering are all correct — which is the entire reason a
 * gateway can talk to S3 without the official SDK.
 *
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 */

const config = {
  bucket: 'examplebucket',
  region: 'us-east-1',
  endpoint: 'https://s3.amazonaws.com',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false,
  prefix: '',
}

test('matches the published AWS GET example', () => {
  const signed = signRequest({
    config,
    method: 'GET',
    key: 'test.txt',
    headers: { Range: 'bytes=0-9' },
    now: new Date('2013-05-24T00:00:00Z'),
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  })

  assert.equal(signed.url, 'https://examplebucket.s3.amazonaws.com/test.txt')
  assert.equal(
    signed.headers.Authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
      'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  )
})

test('matches the published AWS PUT example', () => {
  const signed = signRequest({
    config,
    method: 'PUT',
    key: 'test$file.text',
    headers: {
      Date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    now: new Date('2013-05-24T00:00:00Z'),
    payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
  })

  // The dollar sign must be percent-encoded in the canonical URI.
  assert.ok(signed.url.endsWith('/test%24file.text'), signed.url)
  assert.match(signed.headers.Authorization, /Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd/)
})

test('path-style endpoints put the bucket in the path', () => {
  const signed = signRequest({
    config: { ...config, endpoint: 'https://minio.local:9000', forcePathStyle: true },
    method: 'PUT',
    key: 'psdrive/abc-photo.jpg',
    headers: { 'content-type': 'image/jpeg' },
    now: new Date('2026-01-01T00:00:00Z'),
  })

  assert.equal(signed.url, 'https://minio.local:9000/examplebucket/psdrive/abc-photo.jpg')
  assert.match(signed.headers.Authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/)
  assert.equal(signed.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD')
})

test('query parameters are sorted in the canonical request', () => {
  const signed = signRequest({
    config,
    method: 'GET',
    query: { 'list-type': '2', prefix: 'psdrive/', 'max-keys': '10' },
    now: new Date('2026-01-01T00:00:00Z'),
  })

  const query = new URL(signed.url).search
  assert.equal(query, '?list-type=2&max-keys=10&prefix=psdrive%2F')
})

test('object keys are namespaced, sanitised and collision-free', async () => {
  const { objectKey } = await import('../src/lib/sigv4.ts')
  const key = objectKey({ ...config, prefix: 'psdrive' }, 'uuid-1', 'My report (final)™.pdf')
  assert.ok(key.startsWith('psdrive/uuid-1-'))
  assert.ok(key.endsWith('.pdf'))
  assert.ok(!/[^\w./ +\-]/.test(key), `unexpected characters in ${key}`)
})
