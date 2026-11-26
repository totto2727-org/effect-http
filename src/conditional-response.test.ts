import { Effect, FileSystem, Layer, Option, Stream } from 'effect'
import { Digest } from 'effect/crypto'
import { Headers, HttpEffect, HttpMiddleware, HttpPlatform, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import * as ConditionalRequest from './conditional-request.ts'

type WebHandler = (request: Request) => Promise<Response>
const url = 'https://example.com/'

const entityTag = (response: Response): string => Option.getOrThrow(Option.fromNullishOr(response.headers.get('etag')))

const variesByEncoding = (response: Response): boolean =>
  Option.exists(Option.fromNullishOr(response.headers.get('vary')), (vary) => vary.includes('Accept-Encoding'))

const validatingHandler = (response: HttpServerResponse.HttpServerResponse, maxBodyBytes: number): WebHandler => {
  const app = Effect.succeed(response).pipe(
    ConditionalRequest.middleware({ maxBodyBytes }),
    Effect.provide(Digest.layerWebCrypto),
  )
  return HttpEffect.toWebHandler(app)
}

const compressedHandler = (response: HttpServerResponse.HttpServerResponse): WebHandler => {
  const platform = HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({})))
  const app = Effect.succeed(response).pipe(
    ConditionalRequest.middleware({ maxBodyBytes: 4096 }),
    HttpMiddleware.compression({ algorithms: ['gzip'], minSize: 0 }),
    Effect.provide(platform),
    Effect.provide(Digest.layerWebCrypto),
  )
  return HttpEffect.toWebHandler(app)
}

describe('date validators on Web responses', () => {
  test('uses the canonical Last-Modified date in a real conditional HTTP response', async () => {
    const lastModified = 'Wed, 01 Jan 2025 00:00:00 GMT'
    const response = HttpServerResponse.text('body', { headers: { 'last-modified': lastModified } })
    const handler = validatingHandler(response, 0)
    const request = async (date: string): Promise<Response> =>
      handler(new Request(url, { headers: { 'if-modified-since': date } }))
    const matched = await request(lastModified)
    expect(matched.status).toBe(304)
    expect(matched.headers.get('last-modified')).toBe(lastModified)
    const invalid = await request('Thu, 01 Jan 2025 00:00:00 GMT')
    expect(invalid.status).toBe(200)
  })
})

describe('conditional response metadata', () => {
  test.each([
    { encoding: 'gzip', method: 'GET', name: 'if-none-match', status: 304, value: '"existing"' },
    {
      encoding: new globalThis.Headers().get('content-encoding'),
      method: 'PUT',
      name: 'if-match',
      status: 412,
      value: '"other"',
    },
  ])(
    'preserves response cookies on $method conditional responses',
    async ({ encoding, method, name, status, value }) => {
      const response = HttpServerResponse.setCookieUnsafe(
        HttpServerResponse.text('body', { headers: { 'content-encoding': 'gzip', etag: '"existing"' } }),
        'session',
        'value',
      )
      const headers = Headers.fromInput({ [name]: value })
      const selected = ConditionalRequest.apply(response, { headers, method })
      const handler = HttpEffect.toWebHandler(Effect.succeed(selected))
      const result = await handler(new Request(url, { method }))
      expect(result.status).toBe(status)
      expect(result.headers.get('set-cookie')).toContain('session=value')
      expect(result.headers.get('content-encoding')).toBe(encoding)
      await expect(result.text()).resolves.toBe('')
    },
  )
})

describe('head validators', () => {
  test('does not invent an empty-body tag for HEAD', async () => {
    const handler = validatingHandler(HttpServerResponse.empty({ status: 200 }), 10)
    const response = await handler(
      new Request(url, {
        headers: { 'if-none-match': '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"' },
        method: 'HEAD',
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBeNull()
  })

  test('applies explicit validators on HEAD without hashing', async () => {
    const reply = HttpServerResponse.empty({ headers: { etag: '"get-representation"' }, status: 200 })
    const handler = validatingHandler(reply, 10)
    const response = await handler(
      new Request(url, { headers: { 'if-none-match': '"get-representation"' }, method: 'HEAD' }),
    )
    expect(response.status).toBe(304)
  })
})

describe('validators and compressed representations', () => {
  test('validates final representations after real Effect compression', async () => {
    const reply = HttpServerResponse.text('compress me '.repeat(100))
    const handler = compressedHandler(reply)
    const identity = await handler(new Request(url, { headers: { 'accept-encoding': 'identity' } }))
    const tag = entityTag(identity)
    expect(tag).toMatch(/^"[a-f0-9]{64}"$/u)
    const compressed = await handler(new Request(url, { headers: { 'accept-encoding': 'gzip', 'if-none-match': tag } }))
    const bytes = await compressed.arrayBuffer()
    const unchanged = await handler(
      new Request(url, { headers: { 'accept-encoding': 'identity', 'if-none-match': tag } }),
    )
    expect({
      bodyPresent: bytes.byteLength > 0,
      compressedStatus: compressed.status,
      encoding: compressed.headers.get('content-encoding'),
      generatedTag: compressed.headers.has('etag'),
      unchangedStatus: unchanged.status,
      variesWhenCompressed: variesByEncoding(compressed),
      variesWhenUnchanged: variesByEncoding(unchanged),
    }).toStrictEqual({
      bodyPresent: true,
      compressedStatus: 200,
      encoding: 'gzip',
      generatedTag: false,
      unchangedStatus: 304,
      variesWhenCompressed: true,
      variesWhenUnchanged: true,
    })
  })

  test('preserves compression metadata for explicit weak validators on real compressed304', async () => {
    const reply = HttpServerResponse.text('compress me '.repeat(100), { headers: { etag: 'W/"shared"' } })
    const handler = compressedHandler(reply)
    const response = await handler(
      new Request(url, { headers: { 'accept-encoding': 'gzip', 'if-none-match': 'W/"shared"' } }),
    )
    expect(response.status).toBe(304)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')).toContain('Accept-Encoding')
    await expect(response.text()).resolves.toBe('')
  })
})

describe('automatic ETags for bounded representations', () => {
  test('hashes bounded in-memory bytes with the caller-provided crypto service and preserves 304 metadata', async () => {
    const reply = HttpServerResponse.text('hello', {
      headers: { 'cache-control': 'public, max-age=60', 'content-location': '/x', vary: 'accept' },
    })
    const handler = validatingHandler(reply, 10)
    const first = await handler(new Request(url))
    const value = entityTag(first)
    expect(value).toMatch(/^"[a-f0-9]{64}"$/u)
    const response = await handler(new Request(url, { headers: { 'if-none-match': value } }))
    expect({
      cache: response.headers.get('cache-control'),
      hasLength: response.headers.has('content-length'),
      location: response.headers.get('content-location'),
      status: response.status,
      vary: response.headers.get('vary'),
    }).toStrictEqual({ cache: 'public, max-age=60', hasLength: false, location: '/x', status: 304, vary: 'accept' })
    await expect(response.text()).resolves.toBe('')
  })

  test('respects an existing validator', async () => {
    const reply = HttpServerResponse.text('hello', { headers: { etag: '"existing"' } })
    const handler = validatingHandler(reply, 1)
    const response = await handler(new Request(url, { headers: { 'if-none-match': '"existing"' } }))
    expect(response.status).toBe(304)
  })

  const streamedBody = Stream.make(new Uint8Array([1]))

  test.each([
    HttpServerResponse.text('oversized'),
    HttpServerResponse.stream(streamedBody),
    HttpServerResponse.formData(new FormData()),
    HttpServerResponse.raw('raw'),
  ])('does not hash excluded body %#', async (response) => {
    const handler = validatingHandler(response, 1)
    const reply = await handler(new Request(url))
    expect(reply.headers.get('etag')).toBeNull()
  })
})
