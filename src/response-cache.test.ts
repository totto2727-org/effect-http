import { live } from '@effect/vitest'
import { Array, Data, Deferred, Effect, Exit, Fiber, Predicate, Ref, Result, Stream } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect } from 'vite-plus/test'

import * as ResponseCache from './response-cache.ts'

type WebHandler = (request: Request) => Promise<Response>

const readBody = async (handler: WebHandler, request: Request): Promise<string> => {
  const response = await handler(request)
  return response.text()
}

const rootRequest = (init?: RequestInit): Request => new Request('https://example.com/', init)
const themeRequest = (theme: string): Request =>
  new Request('https://example.com/', {
    headers: { 'accept-language': 'ja', 'x-theme': theme },
  })

const increment = (value: number): number => value + 1

class ExpectedBytes extends Data.TaggedError('ExpectedBytes') {}

const responseBytes = (response: HttpServerResponse.HttpServerResponse): Uint8Array => {
  const { body } = response
  if (!Predicate.isTagged(body, 'Uint8Array')) {
    throw new ExpectedBytes()
  }
  return body.body
}

const options = {
  capacity: 2,
  maxBodyBytes: 100,
  publicRoute: true,
  ttlMilliseconds: 10_000,
  vary: ['accept-language'],
} as const
const fixture = Effect.fnUntraced(function* (
  response?: HttpServerResponse.HttpServerResponse,
  overrides: Partial<ResponseCache.Options> = {},
) {
  const count = yield* Ref.make(0)
  const cache = yield* ResponseCache.make({ ...options, ...overrides })
  const origin = Predicate.isNullish(response)
    ? Effect.map(Ref.updateAndGet(count, increment), (value) => HttpServerResponse.text(String(value)))
    : Effect.succeed(response)
  const handler = HttpEffect.toWebHandler(cache.middleware(origin))
  return { cache, count: Ref.get(count), handler }
})

describe('response cache behavior', () => {
  live.each([
    { capacity: 0 },
    { capacity: 1.5 },
    { maxBodyBytes: -1 },
    { maxBodyBytes: Number.POSITIVE_INFINITY },
    { ttlMilliseconds: 0 },
    { ttlMilliseconds: Number.NaN },
    { vary: ['authorization'] },
    { vary: ['bad,header'] },
    { vary: ['accept-language\n'] },
  ])('reports invalid configuration through its generated error %j', (overrides) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(ResponseCache.make({ ...options, ...overrides }))
      const error = Result.getOrThrow(Exit.findDefect(exit))
      expect(error).toBeInstanceOf(ResponseCache.ConfigError)
    }),
  )
})

describe('response variants and cache hits', () => {
  live('normalizes and deduplicates declared variants before emitting Vary and keying responses', () =>
    Effect.gen(function* () {
      const { handler } = yield* fixture(undefined, { vary: ['X-Theme', 'Accept-Language', 'accept-language'] })
      const first = yield* Effect.promise(async () => handler(themeRequest('dark')))
      expect(first.headers.get('vary')).toBe('accept-language, x-theme')
      yield* Effect.promise(async () => expect(first.text()).resolves.toBe('1'))
      expect(yield* Effect.promise(async () => readBody(handler, themeRequest('light')))).toBe('2')
      expect(yield* Effect.promise(async () => readBody(handler, themeRequest('dark')))).toBe('1')
    }),
  )

  live('reuses public GET responses and manually invalidates', () =>
    Effect.gen(function* () {
      const { handler, cache } = yield* fixture()
      expect(yield* Effect.promise(async () => readBody(handler, rootRequest()))).toBe('1')
      const hit = yield* Effect.promise(async () => handler(rootRequest()))
      yield* Effect.promise(async () => expect(hit.text()).resolves.toBe('1'))
      expect(hit.headers.get('age')).toBe('0')
      yield* cache.invalidateAll
      expect(yield* Effect.promise(async () => readBody(handler, rootRequest()))).toBe('2')
    }),
  )

  live('isolates declared variants, hosts and targets', () =>
    Effect.gen(function* () {
      const { handler } = yield* fixture(undefined, { capacity: 10 })
      const requestLanguage = async (url: string, language: string): Promise<string> =>
        readBody(handler, new Request(url, { headers: { 'accept-language': language } }))
      yield* Effect.promise(async () => expect(requestLanguage('https://one.test/a', 'en')).resolves.toBe('1'))
      yield* Effect.promise(async () => expect(requestLanguage('https://one.test/a', 'ja')).resolves.toBe('2'))
      yield* Effect.promise(async () => expect(requestLanguage('https://two.test/a', 'en')).resolves.toBe('3'))
      yield* Effect.promise(async () => expect(requestLanguage('https://one.test/b', 'en')).resolves.toBe('4'))
      yield* Effect.promise(async () => expect(requestLanguage('https://one.test/a', 'en')).resolves.toBe('1'))
    }),
  )
})

describe('eviction and request eligibility', () => {
  live('evicts the least recently used entry', () =>
    Effect.gen(function* () {
      const { handler } = yield* fixture()
      const requestPath = async (path: string): Promise<string> =>
        readBody(handler, new Request(`https://example.com/${path}`))
      yield* Effect.promise(async () => expect(requestPath('a')).resolves.toBe('1'))
      yield* Effect.promise(async () => expect(requestPath('b')).resolves.toBe('2'))
      yield* Effect.promise(async () => expect(requestPath('a')).resolves.toBe('1'))
      yield* Effect.promise(async () => expect(requestPath('c')).resolves.toBe('3'))
      yield* Effect.promise(async () => expect(requestPath('b')).resolves.toBe('4'))
    }),
  )

  live.each([
    { authorization: 'Bearer x' },
    { cookie: 'id=x' },
    { 'cache-control': 'no-cache' },
    { 'cache-control': 'no-store' },
    { pragma: 'no-cache' },
    { range: 'bytes=0-1' },
    { 'if-none-match': '"x"' },
    { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
  ])('bypasses sensitive or conditional request %j', (headers) =>
    Effect.gen(function* () {
      const { handler } = yield* fixture()
      expect(yield* Effect.promise(async () => readBody(handler, rootRequest({ headers })))).toBe('1')
      expect(yield* Effect.promise(async () => readBody(handler, rootRequest({ headers })))).toBe('2')
    }),
  )

  live.each(['POST', 'HEAD', 'QUERY'])('bypasses %s methods', (method) =>
    Effect.gen(function* () {
      const { handler, count } = yield* fixture()
      yield* Effect.promise(async () => handler(new Request('https://example.com/', { method })))
      yield* Effect.promise(async () => handler(new Request('https://example.com/', { method })))
      expect(yield* count).toBe(2)
    }),
  )
})

describe('response eligibility', () => {
  live.each([
    { 'cache-control': 'private' },
    { 'cache-control': 'no-store' },
    { 'cache-control': 'no-cache' },
    { 'cache-control': 'max-age=0' },
    { 'cache-control': 'max-age=1, max-age=2' },
    { 'set-cookie': 'id=x' },
    { expires: 'Thu, 01 Jan 1970 00:00:00 GMT' },
    { expires: 'Wed, 01 Jan 2031 00:00:00 GMT' },
    { vary: '*' },
    { vary: 'x-undeclared' },
    { 'content-type': 'text/event-stream' },
    { date: 'Tue, 31 Feb 2026 00:00:00 GMT' },
    { age: '9'.repeat(17) },
    { age: '0\n' },
    { vary: 'accept-language\n' },
    { vary: Array.join(Array.replicate('accept-language', 65), ',') },
  ])('does not store unsafe response %j', (headers) =>
    Effect.gen(function* () {
      const count = yield* Ref.make(0)
      const cache = yield* ResponseCache.make(options)
      const origin = Effect.map(Ref.updateAndGet(count, increment), (value) =>
        HttpServerResponse.text(String(value), { headers }),
      )
      const handler = HttpEffect.toWebHandler(cache.middleware(origin))
      yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      expect(yield* Effect.promise(async () => readBody(handler, new Request('https://example.com/')))).toBe('2')
    }),
  )
})

const streamedBody = Stream.make(new Uint8Array([1]))

const cachedBytes = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const cache = yield* ResponseCache.make(options)
  const handler = cache.middleware(Effect.succeed(HttpServerResponse.uint8Array(bytes)))
  const request = HttpServerRequest.fromWeb(rootRequest())
  return Effect.provideService(handler, HttpServerRequest.HttpServerRequest, request)
})

describe('cacheable body types', () => {
  live.each([
    HttpServerResponse.stream(streamedBody),
    HttpServerResponse.formData(new FormData()),
    HttpServerResponse.raw('raw'),
    HttpServerResponse.text('x'.repeat(101)),
    HttpServerResponse.setCookieUnsafe(HttpServerResponse.text('x'), 'id', 'secret'),
  ])('never stores excluded body or cookie collection %#', (response) =>
    Effect.gen(function* () {
      const count = yield* Ref.make(0)
      const cache = yield* ResponseCache.make(options)
      const origin = Effect.as(Ref.update(count, increment), response)
      const handler = HttpEffect.toWebHandler(cache.middleware(origin))
      yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      expect(yield* Ref.get(count)).toBe(2)
    }),
  )

  live('clones stored bytes on insertion and each hit', () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([1, 2])
      const run = yield* cachedBytes(bytes)
      yield* run
      bytes[0] = 9
      const first = yield* run
      const hit = responseBytes(first)
      expect([...hit]).toStrictEqual([1, 2])
      hit[0] = 8
      const second = yield* run
      expect([...responseBytes(second)]).toStrictEqual([1, 2])
    }),
  )
})

const pausedCacheMiss = Effect.gen(function* () {
  const cache = yield* ResponseCache.make(options)
  const started = yield* Deferred.make<true>()
  const release = yield* Deferred.make<true>()
  const count = yield* Ref.make(0)
  const origin = Effect.gen(function* () {
    const value = yield* Ref.updateAndGet(count, increment)
    if (value === 1) {
      yield* Deferred.succeed(started, true)
      yield* Deferred.await(release)
    }
    return HttpServerResponse.text(String(value))
  })
  const request = HttpServerRequest.fromWeb(rootRequest())
  const run = Effect.provideService(cache.middleware(origin), HttpServerRequest.HttpServerRequest, request)
  return { cache, count, release, run, started }
})

const responseText = (response: HttpServerResponse.HttpServerResponse): Effect.Effect<string> =>
  Effect.promise(async () => HttpServerResponse.toWeb(response).text())

describe('invalidation during a cache miss', () => {
  live('does not repopulate after invalidating an in-flight miss', () =>
    Effect.gen(function* () {
      const { cache, count, release, run, started } = yield* pausedCacheMiss
      const pending = yield* Effect.forkChild(run)
      yield* Deferred.await(started)
      yield* cache.invalidateAll
      const fresh = yield* run
      yield* Deferred.succeed(release, true)
      yield* Fiber.join(pending)
      const hit = yield* run
      expect({
        count: yield* Ref.get(count),
        fresh: yield* responseText(fresh),
        hit: yield* responseText(hit),
      }).toStrictEqual({ count: 2, fresh: '2', hit: '2' })
    }),
  )
})
