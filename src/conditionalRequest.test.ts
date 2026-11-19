import { Data, DateTime, Effect, FileSystem, Layer, Option, Stream, String } from 'effect'
import { Digest } from 'effect/crypto'
import { type Etag, Headers, HttpEffect, HttpMiddleware, HttpPlatform, HttpServerResponse } from 'effect/http'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import * as ConditionalRequest from './conditionalRequest.ts'
import * as HttpDate from './internal/httpDate.ts'

const Tags = Data.taggedEnum<Etag.Etag>()
const etag = Tags.Strong({ value: 'a,b' })

describe('ConditionalRequest', () => {
  it('distinguishes parsed values from unchecked input without breaking Effect interoperability', () => {
    type ParsedEtag = NonNullable<ReturnType<typeof ConditionalRequest.parseEtag>>
    type ParsedDate = Option.Option.Value<ReturnType<typeof HttpDate.parse>>
    expectTypeOf<ParsedEtag>().toExtend<Etag.Etag>()
    expectTypeOf<string>().not.toExtend<ParsedEtag['value']>()
    expectTypeOf<ParsedDate>().toExtend<DateTime.Utc>()
    expectTypeOf<DateTime.Utc>().not.toExtend<ParsedDate>()
    expectTypeOf<string>().not.toExtend<ParsedDate>()
  })
  it('parses Effect tags and distinguishes weak and strong comparison', () => {
    expect(ConditionalRequest.parseEtag('W/"a,b"')).toEqual(Tags.Weak({ value: 'a,b' }))
    expect(ConditionalRequest.parseEtag('"bad\n"')).toBeUndefined()
    expect(ConditionalRequest.matches(etag, Tags.Weak({ value: 'a,b' }))).toBe(true)
    expect(ConditionalRequest.matches(etag, Tags.Weak({ value: 'a,b' }), true)).toBe(false)
  })
  it.each(['GET', 'HEAD'])('returns 304 for weak matching %s retrieval', (method) => {
    expect(ConditionalRequest.evaluate({ method, etag, headers: { 'if-none-match': '"other", W/"a,b"' } })).toBe(
      'NotModified',
    )
  })
  it('protects unsafe writes through pre-handler evaluation', () => {
    expect(ConditionalRequest.evaluate({ method: 'PUT', etag, headers: { 'if-match': 'W/"a,b"' } })).toBe(
      'PreconditionFailed',
    )
    expect(ConditionalRequest.evaluate({ method: 'PUT', etag, headers: { 'if-none-match': '*' } })).toBe(
      'PreconditionFailed',
    )
    expect(ConditionalRequest.evaluate({ method: 'PUT', exists: false, headers: { 'if-none-match': '*' } })).toBe(
      'Proceed',
    )
  })
  it('does not turn malformed lists into a match', () => {
    expect(ConditionalRequest.evaluate({ method: 'GET', etag, headers: { 'if-none-match': '"a,b",' } })).toBe('Proceed')
  })
  it.each(['"a,b", garbage', 'garbage, "a,b"', '"a,b",,"other"', '"a,b" , \t'])(
    'rejects an entire malformed list even when it contains a match: %s',
    (value) => {
      expect(ConditionalRequest.evaluate({ method: 'GET', etag, headers: { 'if-none-match': value } })).toBe('Proceed')
      expect(ConditionalRequest.evaluate({ method: 'PUT', etag, headers: { 'if-match': value } })).toBe(
        'PreconditionFailed',
      )
    },
  )
  it('accepts 64 quoted tags, including opaque commas, without accepting a 65th', () => {
    const allowed = Array(63).fill('"other"').concat('W/"a,b"').join(',')
    expect(ConditionalRequest.evaluate({ method: 'GET', etag, headers: { 'if-none-match': allowed } })).toBe(
      'NotModified',
    )
    expect(
      ConditionalRequest.evaluate({ method: 'GET', etag, headers: { 'if-none-match': `${allowed},"last"` } }),
    ).toBe('Proceed')
  })
  it('counts the entire ETag including quotes and the weak prefix at the byte limit', () => {
    const opaque = String.repeat(8188)('é')
    expect(ConditionalRequest.parseEtag(`W/"${opaque}"`)).toEqual(Tags.Weak({ value: opaque }))
    expect(ConditionalRequest.parseEtag(`W/"${opaque}x"`)).toBeUndefined()
    expect(ConditionalRequest.parseEtag(`"${opaque}xx"`)).toEqual(Tags.Strong({ value: `${opaque}xx` }))
    expect(ConditionalRequest.parseEtag('""')).toEqual(Tags.Strong({ value: '' }))
  })
  it.each(['"a,b", "bad tag"', '"a,b", "bad\ttag"', '"a,b", w/"other"', '"a,b", "\x7f"', '"a,b", "Ā"'])(
    'rejects a match followed by a token with invalid wire format: %s',
    (value) => {
      expect(ConditionalRequest.evaluate({ method: 'PUT', etag, headers: { 'if-match': value } })).toBe(
        'PreconditionFailed',
      )
    },
  )
  it('throws generated configuration errors rather than plain errors', () => {
    expect(() => ConditionalRequest.middleware({ maxBodyBytes: -1 })).toThrow(ConditionalRequest.ConfigError)
    expect(() =>
      ConditionalRequest.apply(
        HttpServerResponse.text('body'),
        { method: 'GET', headers: Headers.empty },
        {
          etag: Tags.Strong({ value: 'bad"tag' }),
        },
      ),
    ).toThrow(ConditionalRequest.ConfigError)
    expect(() =>
      ConditionalRequest.apply(
        HttpServerResponse.text('body'),
        { method: 'GET', headers: Headers.empty },
        {
          lastModified: new Date(NaN),
        },
      ),
    ).toThrow(ConditionalRequest.ConfigError)
  })
  it('gives If-None-Match precedence over modification time', () => {
    expect(
      ConditionalRequest.evaluate({
        method: 'GET',
        etag,
        lastModified: new Date('2020-01-01'),
        headers: { 'if-none-match': '"other"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
      }),
    ).toBe('Proceed')
  })
  it.each(['"a,b"\n', '"a,b"\r', '"' + 'x'.repeat(8192) + '"'])('rejects non-exact or oversized ETags %#', (value) => {
    expect(ConditionalRequest.parseEtag(value)).toBeUndefined()
  })
  it.each(['"a,b"\n', '\u00a0"a,b"', Array(65).fill('"a,b"').join(','), '"' + 'x'.repeat(8192) + '"'])(
    'never matches malformed or oversized lists %#',
    (value) => {
      expect(ConditionalRequest.evaluate({ method: 'GET', etag, headers: { 'if-none-match': value } })).toBe('Proceed')
    },
  )
  it.each([
    'Tue, 31 Feb 2026 00:00:00 GMT',
    'Mon, 01 Jan 2025 00:00:00 GMT',
    'Wed, 01 Jan 2025 00:00:00 GMT\n',
    'Wed, 01 Jan 2025 24:00:00 GMT',
  ])('ignores invalid HTTP dates %#', (value) => {
    expect(
      ConditionalRequest.evaluate({
        method: 'GET',
        lastModified: new Date('2020-01-01'),
        headers: { 'if-modified-since': value },
      }),
    ).toBe('Proceed')
  })
  it('uses the canonical Last-Modified date in a real conditional HTTP response', async () => {
    const lastModified = 'Wed, 01 Jan 2025 00:00:00 GMT'
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 0 })(
        Effect.succeed(HttpServerResponse.text('body', { headers: { 'last-modified': lastModified } })),
      ).pipe(Effect.provide(Digest.layerWebCrypto)),
    )
    const request = (date: string) =>
      handler(new Request('https://example.com/', { headers: { 'if-modified-since': date } }))
    const matched = await request(lastModified)
    expect(matched.status).toBe(304)
    expect(matched.headers.get('last-modified')).toBe(lastModified)
    expect((await request('Thu, 01 Jan 2025 00:00:00 GMT')).status).toBe(200)
  })
  it.each(['Sat, 01 Jan 0000 00:00:00 GMT', 'Mon, 01 Jan 0001 00:00:00 GMT', 'Thu, 01 Jan 0099 00:00:00 GMT'])(
    'ignores low-year preconditions without broadening the accepted date grammar: %s',
    (value) => {
      expect(
        ConditionalRequest.evaluate({
          method: 'PUT',
          lastModified: new Date('2020-01-01'),
          headers: { 'if-unmodified-since': value },
        }),
      ).toBe('Proceed')
    },
  )
  it.each([
    ['GET', 'if-none-match', 304],
    ['PUT', 'if-match', 412],
  ] as const)('preserves response cookies on %s conditional responses', async (method, name, status) => {
    const response = HttpServerResponse.setCookieUnsafe(
      HttpServerResponse.text('body', { headers: { etag: '"existing"', 'content-encoding': 'gzip' } }),
      'session',
      'value',
    )
    const handler = HttpEffect.toWebHandler(
      Effect.succeed(
        ConditionalRequest.apply(response, {
          method,
          headers: Headers.fromInput({ [name]: name === 'if-match' ? '"other"' : '"existing"' }),
        }),
      ),
    )
    const result = await handler(new Request('https://example.com/', { method }))
    expect(result.status).toBe(status)
    expect(result.headers.get('set-cookie')).toContain('session=value')
    expect(result.headers.get('content-encoding')).toBe(status === 304 ? 'gzip' : null)
    expect(await result.text()).toBe('')
  })
  it('does not invent an empty-body tag for HEAD', async () => {
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 10 })(
        Effect.succeed(HttpServerResponse.empty({ status: 200 })),
      ).pipe(Effect.provide(Digest.layerWebCrypto)),
    )
    const response = await handler(
      new Request('https://example.com/', {
        method: 'HEAD',
        headers: { 'if-none-match': '"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"' },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBeNull()
  })
  it('applies explicit validators on HEAD without hashing', async () => {
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 10 })(
        Effect.succeed(HttpServerResponse.empty({ status: 200, headers: { etag: '"get-representation"' } })),
      ).pipe(Effect.provide(Digest.layerWebCrypto)),
    )
    expect(
      (
        await handler(
          new Request('https://example.com/', { method: 'HEAD', headers: { 'if-none-match': '"get-representation"' } }),
        )
      ).status,
    ).toBe(304)
  })
  it('validates final representations after real Effect compression', async () => {
    const platform = HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({})))
    const handler = HttpEffect.toWebHandler(
      Effect.succeed(HttpServerResponse.text('compress me '.repeat(100))).pipe(
        ConditionalRequest.middleware({ maxBodyBytes: 4096 }),
        HttpMiddleware.compression({ minSize: 0, algorithms: ['gzip'] }),
        Effect.provide(platform),
        Effect.provide(Digest.layerWebCrypto),
      ),
    )
    const identity = await handler(new Request('https://example.com/', { headers: { 'accept-encoding': 'identity' } }))
    const tag = identity.headers.get('etag')
    expect(tag).toMatch(/^"[a-f0-9]{64}"$/)
    const compressed = await handler(
      new Request('https://example.com/', { headers: { 'accept-encoding': 'gzip', 'if-none-match': tag ?? '' } }),
    )
    expect(compressed.status).toBe(200)
    expect(compressed.headers.get('content-encoding')).toBe('gzip')
    expect(compressed.headers.get('vary')).toContain('Accept-Encoding')
    expect(compressed.headers.get('etag')).toBeNull()
    expect((await compressed.arrayBuffer()).byteLength).toBeGreaterThan(0)
    const unchanged = await handler(
      new Request('https://example.com/', { headers: { 'accept-encoding': 'identity', 'if-none-match': tag ?? '' } }),
    )
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('vary')).toContain('Accept-Encoding')
  })
  it('preserves compression metadata for explicit weak validators on real compressed304', async () => {
    const platform = HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({})))
    const handler = HttpEffect.toWebHandler(
      Effect.succeed(HttpServerResponse.text('compress me '.repeat(100), { headers: { etag: 'W/"shared"' } })).pipe(
        ConditionalRequest.middleware({ maxBodyBytes: 4096 }),
        HttpMiddleware.compression({ minSize: 0, algorithms: ['gzip'] }),
        Effect.provide(platform),
        Effect.provide(Digest.layerWebCrypto),
      ),
    )
    const response = await handler(
      new Request('https://example.com/', { headers: { 'accept-encoding': 'gzip', 'if-none-match': 'W/"shared"' } }),
    )
    expect(response.status).toBe(304)
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(response.headers.get('vary')).toContain('Accept-Encoding')
    expect(await response.text()).toBe('')
  })
  it('hashes bounded in-memory bytes with the caller-provided crypto service and preserves 304 metadata', async () => {
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 10 })(
        Effect.succeed(
          HttpServerResponse.text('hello', {
            headers: { 'cache-control': 'public, max-age=60', vary: 'accept', 'content-location': '/x' },
          }),
        ),
      ).pipe(Effect.provide(Digest.layerWebCrypto)),
    )
    const first = await handler(new Request('https://example.com/'))
    const value = first.headers.get('etag')
    expect(value).toMatch(/^"[a-f0-9]{64}"$/)
    const response = await handler(new Request('https://example.com/', { headers: { 'if-none-match': value ?? '' } }))
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('cache-control')).toBe('public, max-age=60')
    expect(response.headers.get('vary')).toBe('accept')
    expect(response.headers.get('content-location')).toBe('/x')
    expect(response.headers.get('content-length')).toBeNull()
  })
  it('respects an existing validator', async () => {
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 1 })(
        Effect.succeed(HttpServerResponse.text('hello', { headers: { etag: '"existing"' } })),
      ).pipe(Effect.provide(Digest.layerWebCrypto)),
    )
    expect(
      (await handler(new Request('https://example.com/', { headers: { 'if-none-match': '"existing"' } }))).status,
    ).toBe(304)
  })
  it.each([
    HttpServerResponse.text('oversized'),
    HttpServerResponse.stream(Stream.make(new Uint8Array([1]))),
    HttpServerResponse.formData(new FormData()),
    HttpServerResponse.raw('raw'),
  ])('does not hash excluded body %#', async (response) => {
    const handler = HttpEffect.toWebHandler(
      ConditionalRequest.middleware({ maxBodyBytes: 1 })(Effect.succeed(response)).pipe(
        Effect.provide(Digest.layerWebCrypto),
      ),
    )
    expect((await handler(new Request('https://example.com/'))).headers.get('etag')).toBeNull()
  })
})
