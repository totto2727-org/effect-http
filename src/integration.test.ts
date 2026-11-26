import { live } from '@effect/vitest'
import { Effect, Option, Ref } from 'effect'
import { Digest } from 'effect/crypto'
import type { HttpServerRequest } from 'effect/http'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect } from 'vite-plus/test'

import * as Accepts from './accepts.ts'
import * as CacheControl from './cache-control.ts'
import * as ConditionalRequest from './conditional-request.ts'
import * as Csrf from './csrf.ts'
import * as ResponseCache from './response-cache.ts'
// oxlint-disable-next-line import/max-dependencies -- This integration test verifies all six HTTP utilities together.
import * as SecureHeaders from './secure-headers.ts'

type WebHandler = (request: Request) => Promise<Response>
const increment = (value: number): number => value + 1

const contentRequest = (language: string, headers: Record<string, string> = {}): Request =>
  new Request('https://example.com/content', { headers: { 'accept-language': language, ...headers } })

const runGet = (handler: WebHandler, language: string, headers?: Record<string, string>): Effect.Effect<Response> =>
  Effect.promise(async () => handler(contentRequest(language, headers)))

const readText = (response: Response): Effect.Effect<string> => Effect.promise(async () => response.text())

const negotiatedPage = (
  executions: Ref.Ref<number>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, Accepts.ParseError, HttpServerRequest.HttpServerRequest> =>
  Effect.gen(function* () {
    const language = yield* Accepts.negotiateEffect('language', ['en', 'ja'])
    yield* Ref.update(executions, increment)
    return HttpServerResponse.text(
      Option.getOrElse(language, () => 'unavailable'),
      { headers: { vary: 'Accept-Language' } },
    )
  })

const cachedPage = Effect.gen(function* () {
  const executions = yield* Ref.make(0)
  const cache = yield* ResponseCache.make({
    capacity: 8,
    maxBodyBytes: 1024,
    publicRoute: true,
    ttlMilliseconds: 60_000,
    vary: ['accept-language'],
  })
  const app = negotiatedPage(executions).pipe(
    CacheControl.middleware({ maxAge: 30, public: true }),
    cache.middleware,
    ConditionalRequest.middleware({ maxBodyBytes: 1024 }),
    Csrf.middleware(),
    SecureHeaders.middleware(),
    Effect.provide(Digest.layerWebCrypto),
    Effect.catchTag('AcceptsParseError', () => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
  )
  return { cache, executions, handler: HttpEffect.toWebHandler(app) }
})

const englishResponses = Effect.fnUntraced(function* (handler: WebHandler, counter: Ref.Ref<number>) {
  const initial = yield* runGet(handler, 'en')
  const body = yield* readText(initial)
  const hit = yield* runGet(handler, 'en')
  return {
    body,
    etag: initial.headers.get('etag'),
    executions: yield* Ref.get(counter),
    hitAge: hit.headers.get('age'),
    hitBody: yield* readText(hit),
    hitEtag: hit.headers.get('etag'),
  }
})

const localizedAndConditionalResponses = Effect.fnUntraced(function* (handler: WebHandler, etag: string) {
  const japanese = yield* runGet(handler, 'ja')
  const japaneseBody = yield* readText(japanese)
  const unchanged = yield* runGet(handler, 'en', { 'if-none-match': etag })
  return {
    conditionalBody: yield* readText(unchanged),
    conditionalEtag: unchanged.headers.get('etag'),
    conditionalStatus: unchanged.status,
    contentOptions: unchanged.headers.get('x-content-type-options'),
    japaneseBody,
    japaneseEtagDiffers: japanese.headers.get('etag') !== etag,
    policy: unchanged.headers.get('cache-control'),
    varyIncludesPolicies: /^(?=.*accept-language)(?=.*sec-fetch-site)/u.test(
      unchanged.headers.get('vary')?.toLowerCase() ?? '',
    ),
  }
})

describe('composed GET policies', () => {
  live('combines negotiation, public caching, validators and security through real Web requests', () =>
    Effect.gen(function* () {
      const { cache, executions, handler } = yield* cachedPage
      const english = yield* englishResponses(handler, executions)
      expect(english.etag).toMatch(/^"[a-f0-9]{64}"$/u)
      expect(english).toMatchObject({
        body: 'en',
        executions: 1,
        hitAge: '0',
        hitBody: 'en',
        hitEtag: english.etag,
      })
      const local = yield* localizedAndConditionalResponses(handler, english.etag ?? '')
      expect(local).toStrictEqual({
        conditionalBody: '',
        conditionalEtag: english.etag,
        conditionalStatus: 304,
        contentOptions: 'nosniff',
        japaneseBody: 'ja',
        japaneseEtagDiffers: true,
        policy: 'public, max-age=30',
        varyIncludesPolicies: true,
      })
      yield* cache.invalidateAll
      yield* runGet(handler, 'en')
      expect(yield* Ref.get(executions)).toBe(4)
    }),
  )
})

describe('composed write policies', () => {
  live('checks csrf before handler work and applies security headers to the denial', () =>
    Effect.gen(function* () {
      const writes = yield* Ref.make(0)
      const app = Effect.as(Ref.update(writes, increment), HttpServerResponse.empty({ status: 204 }))
      const handler = HttpEffect.toWebHandler(app.pipe(Csrf.middleware(), SecureHeaders.middleware()))
      const denied = yield* Effect.promise(async () =>
        handler(
          new Request('https://example.com/write', {
            body: '{}',
            headers: {
              'content-type': 'application/json',
              origin: 'https://attacker.test',
              'sec-fetch-site': 'same-origin',
            },
            method: 'POST',
          }),
        ),
      )
      expect({
        cache: denied.headers.get('cache-control'),
        frames: denied.headers.get('x-frame-options'),
        status: denied.status,
        writes: yield* Ref.get(writes),
      }).toStrictEqual({ cache: 'no-store', frames: 'DENY', status: 403, writes: 0 })
      const allowed = yield* Effect.promise(async () =>
        handler(
          new Request('https://example.com/write', { headers: { origin: 'https://example.com' }, method: 'POST' }),
        ),
      )
      expect({ status: allowed.status, writes: yield* Ref.get(writes) }).toStrictEqual({ status: 204, writes: 1 })
    }),
  )
})
