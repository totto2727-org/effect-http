import { live } from '@effect/vitest'
import { Clock, Effect, MutableRef, Ref } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect } from 'vite-plus/test'

import * as ResponseCache from './response-cache.ts'

type WebHandler = (request: Request) => Promise<Response>

const readBody = async (handler: WebHandler, request: Request): Promise<string> => {
  const response = await handler(request)
  return response.text()
}

const options = {
  capacity: 2,
  maxBodyBytes: 100,
  publicRoute: true,
  ttlMilliseconds: 10_000,
  vary: ['accept-language'],
} as const

interface ControlledClock {
  clock: Clock.Clock
  set: (millis: number) => void
}

const clockAt = (initial: number): ControlledClock => {
  const current = MutableRef.make(initial)
  const currentTimeMillisUnsafe = (): number => MutableRef.get(current)
  const currentTimeNanosUnsafe = (): bigint => BigInt(Math.trunc(currentTimeMillisUnsafe())) * BigInt(1_000_000)
  return {
    clock: {
      currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
      currentTimeMillisUnsafe,
      currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
      currentTimeNanosUnsafe,
      monotonicTimeNanos: Effect.sync(currentTimeNanosUnsafe),
      monotonicTimeNanosUnsafe: currentTimeNanosUnsafe,
      sleep: () => Effect.void,
    },
    set: (millis) => {
      MutableRef.set(current, millis)
    },
  }
}

const increment = (value: number): number => value + 1

const timedHandler = Effect.fnUntraced(function* (
  origin: Effect.Effect<HttpServerResponse.HttpServerResponse>,
  clock: Clock.Clock,
  config: ResponseCache.Options = options,
) {
  const cache = yield* ResponseCache.make(config).pipe(Effect.provideService(Clock.Clock, clock))
  return HttpEffect.toWebHandler(cache.middleware(origin).pipe(Effect.provideService(Clock.Clock, clock)))
})

describe('response cache freshness', () => {
  live.each([false, true])(
    'expires subsecond-aged Date responses exactly at freshness boundary, delayed=%s',
    (delayed) =>
      Effect.gen(function* () {
        const { clock, set } = clockAt(delayed ? 500 : 999)
        const count = yield* Ref.make(0)
        const origin = Effect.map(Ref.updateAndGet(count, increment), (value) => {
          if (value === 1 && delayed) {
            set(999)
          }
          return HttpServerResponse.text(String(value), {
            headers: { 'cache-control': 'max-age=1', date: 'Thu, 01 Jan 1970 00:00:00 GMT' },
          })
        })
        const handler = yield* timedHandler(origin, clock)
        expect(yield* Effect.promise(async () => readBody(handler, new Request('https://example.com/')))).toBe('1')
        const hit = yield* Effect.promise(async () => handler(new Request('https://example.com/')))
        yield* Effect.promise(async () => expect(hit.text()).resolves.toBe('1'))
        expect(hit.headers.get('age')).toBe('0')
        set(1000)
        expect(yield* Effect.promise(async () => readBody(handler, new Request('https://example.com/')))).toBe('2')
      }),
  )
})

describe('response age headers', () => {
  live.each([
    { elapsed: 1999.999, expected: '1' },
    { elapsed: 4_503_599_627_370_401_000, expected: '4503599627370401' },
  ])('emits integer Age for elapsed milliseconds $elapsed', ({ elapsed, expected }) =>
    Effect.gen(function* () {
      const { clock, set } = clockAt(0)
      const origin = Effect.succeed(HttpServerResponse.text('cached'))
      const handler = yield* timedHandler(origin, clock, { ...options, ttlMilliseconds: 1e20 })
      yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      set(elapsed)
      const hit = yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      yield* Effect.promise(async () => expect(hit.text()).resolves.toBe('cached'))
      expect(hit.headers.get('age')).toBe(expected)
    }),
  )

  live('uses injected Clock for Age and max-age expiry', () =>
    Effect.gen(function* () {
      const { clock, set } = clockAt(0)
      const count = yield* Ref.make(0)
      const origin = Effect.map(Ref.updateAndGet(count, increment), (value) =>
        HttpServerResponse.text(String(value), { headers: { age: '1', 'cache-control': 'max-age=4' } }),
      )
      const handler = yield* timedHandler(origin, clock)
      yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      set(2000)
      const hit = yield* Effect.promise(async () => handler(new Request('https://example.com/')))
      expect({
        age: hit.headers.get('age'),
        body: yield* Effect.promise(async () => hit.text()),
      }).toStrictEqual({ age: '3', body: '1' })
      set(3000)
      expect(yield* Effect.promise(async () => readBody(handler, new Request('https://example.com/')))).toBe('2')
    }),
  )
})
