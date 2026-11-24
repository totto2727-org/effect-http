import { Clock, Deferred, Effect, Exit, Fiber, Result, Stream } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import * as ResponseCache from './responseCache.ts'

const options = {
  capacity: 2,
  ttlMilliseconds: 10_000,
  maxBodyBytes: 100,
  vary: ['accept-language'],
  publicRoute: true,
} as const
const fixture = async (
  response?: HttpServerResponse.HttpServerResponse,
  overrides: Partial<ResponseCache.Options> = {},
) => {
  let count = 0
  const cache = await Effect.runPromise(ResponseCache.make({ ...options, ...overrides }))
  const handler = HttpEffect.toWebHandler(
    cache.middleware(Effect.sync(() => response ?? HttpServerResponse.text(String(++count)))),
  )
  return { cache, handler, count: () => count }
}

describe('ResponseCache', () => {
  test.each([
    { capacity: 0 },
    { capacity: 1.5 },
    { maxBodyBytes: -1 },
    { maxBodyBytes: Infinity },
    { ttlMilliseconds: 0 },
    { ttlMilliseconds: NaN },
    { vary: ['authorization'] },
    { vary: ['bad,header'] },
    { vary: ['accept-language\n'] },
  ])('reports invalid configuration through its generated error %j', async (overrides) => {
    const exit = await Effect.runPromiseExit(ResponseCache.make({ ...options, ...overrides }))
    const error = Result.getOrThrow(Exit.findDefect(exit))
    expect(error).toBeInstanceOf(ResponseCache.ConfigError)
  })
  test('normalizes and deduplicates declared variants before emitting Vary and keying responses', async () => {
    const { handler } = await fixture(undefined, { vary: ['X-Theme', 'Accept-Language', 'accept-language'] })
    const request = (theme: string) =>
      new Request('https://example.com/', {
        headers: { 'accept-language': 'ja', 'x-theme': theme },
      })
    const first = await handler(request('dark'))
    expect(first.headers.get('vary')).toBe('accept-language, x-theme')
    expect(await first.text()).toBe('1')
    expect(await (await handler(request('light'))).text()).toBe('2')
    expect(await (await handler(request('dark'))).text()).toBe('1')
  })
  test('reuses public GET responses and manually invalidates', async () => {
    const { handler, cache } = await fixture()
    const request = () => new Request('https://example.com/')
    expect(await (await handler(request())).text()).toBe('1')
    const hit = await handler(request())
    expect(await hit.text()).toBe('1')
    expect(hit.headers.get('age')).toBe('0')
    await Effect.runPromise(cache.invalidateAll)
    expect(await (await handler(request())).text()).toBe('2')
  })
  test('isolates declared variants, hosts and targets', async () => {
    const { handler } = await fixture(undefined, { capacity: 10 })
    const fetch = async (url: string, language: string) =>
      (await handler(new Request(url, { headers: { 'accept-language': language } }))).text()
    expect(await fetch('https://one.test/a', 'en')).toBe('1')
    expect(await fetch('https://one.test/a', 'ja')).toBe('2')
    expect(await fetch('https://two.test/a', 'en')).toBe('3')
    expect(await fetch('https://one.test/b', 'en')).toBe('4')
    expect(await fetch('https://one.test/a', 'en')).toBe('1')
  })
  test('evicts the least recently used entry', async () => {
    const { handler } = await fixture()
    const fetch = async (path: string) => (await handler(new Request(`https://example.com/${path}`))).text()
    expect(await fetch('a')).toBe('1')
    expect(await fetch('b')).toBe('2')
    expect(await fetch('a')).toBe('1')
    expect(await fetch('c')).toBe('3')
    expect(await fetch('b')).toBe('4')
  })
  test.each([
    { authorization: 'Bearer x' },
    { cookie: 'id=x' },
    { 'cache-control': 'no-cache' },
    { 'cache-control': 'no-store' },
    { pragma: 'no-cache' },
    { range: 'bytes=0-1' },
    { 'if-none-match': '"x"' },
    { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
  ])('bypasses sensitive or conditional request %j', async (headers) => {
    const { handler } = await fixture()
    const request = () => new Request('https://example.com/', { headers })
    expect(await (await handler(request())).text()).toBe('1')
    expect(await (await handler(request())).text()).toBe('2')
  })
  test.each(['POST', 'HEAD', 'QUERY'])('bypasses %s methods', async (method) => {
    const { handler, count } = await fixture()
    await handler(new Request('https://example.com/', { method }))
    await handler(new Request('https://example.com/', { method }))
    expect(count()).toBe(2)
  })
  test.each([
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
    { vary: Array(65).fill('accept-language').join(',') },
  ])('does not store unsafe response %j', async (headers) => {
    let count = 0
    const cache = await Effect.runPromise(ResponseCache.make(options))
    const handler = HttpEffect.toWebHandler(
      cache.middleware(Effect.sync(() => HttpServerResponse.text(String(++count), { headers }))),
    )
    await handler(new Request('https://example.com/'))
    expect(await (await handler(new Request('https://example.com/'))).text()).toBe('2')
  })
  test.each([
    HttpServerResponse.stream(Stream.make(new Uint8Array([1]))),
    HttpServerResponse.formData(new FormData()),
    HttpServerResponse.raw('raw'),
    HttpServerResponse.text('x'.repeat(101)),
    HttpServerResponse.setCookieUnsafe(HttpServerResponse.text('x'), 'id', 'secret'),
  ])('never stores excluded body or cookie collection %#', async (response) => {
    let count = 0
    const cache = await Effect.runPromise(ResponseCache.make(options))
    const handler = HttpEffect.toWebHandler(
      cache.middleware(
        Effect.sync(() => {
          count++
          return response
        }),
      ),
    )
    await handler(new Request('https://example.com/'))
    await handler(new Request('https://example.com/'))
    expect(count).toBe(2)
  })
  test('clones stored bytes on insertion and each hit', async () => {
    const bytes = new Uint8Array([1, 2])
    const cache = await Effect.runPromise(ResponseCache.make(options))
    const handler = cache.middleware(Effect.succeed(HttpServerResponse.uint8Array(bytes)))
    const run = () =>
      Effect.runPromise(
        Effect.provideService(
          handler,
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request('https://example.com/')),
        ),
      )
    await run()
    bytes[0] = 9
    const first = await run()
    if (first.body._tag !== 'Uint8Array') throw new Error('Expected bytes')
    expect([...first.body.body]).toEqual([1, 2])
    first.body.body[0] = 8
    const second = await run()
    if (second.body._tag !== 'Uint8Array') throw new Error('Expected bytes')
    expect([...second.body.body]).toEqual([1, 2])
  })
  test('does not repopulate after invalidating an in-flight miss', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const cache = yield* ResponseCache.make(options)
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let count = 0
        const origin = Effect.gen(function* () {
          const value = ++count
          if (value === 1) {
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }
          return HttpServerResponse.text(String(value))
        })
        const request = HttpServerRequest.fromWeb(new Request('https://example.com/'))
        const run = Effect.provideService(cache.middleware(origin), HttpServerRequest.HttpServerRequest, request)
        const pending = yield* Effect.forkChild(run)
        yield* Deferred.await(started)
        yield* cache.invalidateAll
        const fresh = yield* run
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(pending)
        const hit = yield* run
        return {
          count,
          fresh: yield* Effect.promise(() => HttpServerResponse.toWeb(fresh).text()),
          hit: yield* Effect.promise(() => HttpServerResponse.toWeb(hit).text()),
        }
      }),
    )
    expect(result.count).toBe(2)
    expect(result.hit).toBe('2')
    expect(result.fresh).toBe('2')
  })
  test.each([false, true])(
    'expires subsecond-aged Date responses exactly at freshness boundary, delayed=%s',
    async (delayed) => {
      let now = delayed ? 500 : 999
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => now,
        currentTimeMillis: Effect.sync(() => now),
        currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
        monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
        sleep: () => Effect.void,
      }
      let count = 0
      const cache = await Effect.runPromise(ResponseCache.make(options).pipe(Effect.provideService(Clock.Clock, clock)))
      const handler = HttpEffect.toWebHandler(
        cache
          .middleware(
            Effect.sync(() => {
              count++
              if (count === 1 && delayed) now = 999
              return HttpServerResponse.text(String(count), {
                headers: { date: 'Thu, 01 Jan 1970 00:00:00 GMT', 'cache-control': 'max-age=1' },
              })
            }),
          )
          .pipe(Effect.provideService(Clock.Clock, clock)),
      )
      expect(await (await handler(new Request('https://example.com/'))).text()).toBe('1')
      const hit = await handler(new Request('https://example.com/'))
      expect(await hit.text()).toBe('1')
      expect(hit.headers.get('age')).toBe('0')
      now = 1000
      expect(await (await handler(new Request('https://example.com/'))).text()).toBe('2')
    },
  )
  test.each([
    [1999.999, '1'],
    [4503599627370401000, '4503599627370401'],
  ] as const)('emits integer Age for elapsed milliseconds %s', async (elapsed, expected) => {
    let now = 0
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(Math.trunc(now)) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(Math.trunc(now)) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(Math.trunc(now)) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(Math.trunc(now)) * 1_000_000n),
      sleep: () => Effect.void,
    }
    const cache = await Effect.runPromise(
      ResponseCache.make({ ...options, ttlMilliseconds: 1e20 }).pipe(Effect.provideService(Clock.Clock, clock)),
    )
    const handler = HttpEffect.toWebHandler(
      cache
        .middleware(Effect.succeed(HttpServerResponse.text('cached')))
        .pipe(Effect.provideService(Clock.Clock, clock)),
    )
    await handler(new Request('https://example.com/'))
    now = elapsed
    const hit = await handler(new Request('https://example.com/'))
    expect(await hit.text()).toBe('cached')
    expect(hit.headers.get('age')).toBe(expected)
  })
  test('uses injected Clock for Age and max-age expiry', async () => {
    let now = 0
    const clock: Clock.Clock = {
      currentTimeMillisUnsafe: () => now,
      currentTimeMillis: Effect.sync(() => now),
      currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
      monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
      sleep: () => Effect.void,
    }
    let count = 0
    const cache = await Effect.runPromise(ResponseCache.make(options).pipe(Effect.provideService(Clock.Clock, clock)))
    const handler = HttpEffect.toWebHandler(
      cache
        .middleware(
          Effect.sync(() =>
            HttpServerResponse.text(String(++count), { headers: { 'cache-control': 'max-age=4', age: '1' } }),
          ),
        )
        .pipe(Effect.provideService(Clock.Clock, clock)),
    )
    await handler(new Request('https://example.com/'))
    now = 2000
    const hit = await handler(new Request('https://example.com/'))
    expect(hit.headers.get('age')).toBe('3')
    expect(await hit.text()).toBe('1')
    now = 3000
    expect(await (await handler(new Request('https://example.com/'))).text()).toBe('2')
  })
})
