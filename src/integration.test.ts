import { Effect, Option } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { expect, test } from 'vite-plus/test'

import { Accepts, CacheControl, ConditionalRequest, Csrf, ResponseCache, SecureHeaders } from './index.ts'

test('negotiation, public cache, validators and security policies compose through real Web requests', async () => {
  let executions = 0
  const cache = await Effect.runPromise(
    ResponseCache.make({
      publicRoute: true,
      capacity: 8,
      ttlMilliseconds: 60_000,
      maxBodyBytes: 1024,
      vary: ['accept-language'],
    }),
  )
  const app = Effect.gen(function* () {
    const language = yield* Accepts.negotiateEffect('language', ['en', 'ja'])
    executions++
    return HttpServerResponse.text(
      Option.getOrElse(language, () => 'unavailable'),
      { headers: { vary: 'Accept-Language' } },
    )
  }).pipe(
    CacheControl.middleware({ public: true, maxAge: 30 }),
    cache.middleware,
    ConditionalRequest.middleware({ maxBodyBytes: 1024 }),
    Csrf.middleware(),
    SecureHeaders.middleware(),
    Effect.provide(Digest.layerWebCrypto),
    Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 400 }))),
  )
  const handler = HttpEffect.toWebHandler(app)
  const request = (language: string, headers: Record<string, string> = {}) =>
    new Request('https://example.com/content', { headers: { 'accept-language': language, ...headers } })

  const english = await handler(request('en'))
  expect(await english.text()).toBe('en')
  const englishEtag = english.headers.get('etag')
  expect(englishEtag).toMatch(/^"[a-f0-9]{64}"$/)
  const hit = await handler(request('en'))
  expect(await hit.text()).toBe('en')
  expect(hit.headers.get('age')).toBe('0')
  expect(hit.headers.get('etag')).toBe(englishEtag)
  expect(executions).toBe(1)

  const japanese = await handler(request('ja'))
  expect(await japanese.text()).toBe('ja')
  expect(japanese.headers.get('etag')).not.toBe(englishEtag)
  const unchanged = await handler(request('en', { 'if-none-match': englishEtag ?? '' }))
  expect(unchanged.status).toBe(304)
  expect(await unchanged.text()).toBe('')
  expect(unchanged.headers.get('etag')).toBe(englishEtag)
  expect(unchanged.headers.get('cache-control')).toBe('public, max-age=30')
  expect(unchanged.headers.get('x-content-type-options')).toBe('nosniff')
  expect(unchanged.headers.get('vary')?.toLowerCase()).toContain('accept-language')
  expect(unchanged.headers.get('vary')?.toLowerCase()).toContain('sec-fetch-site')

  await Effect.runPromise(cache.invalidateAll)
  await handler(request('en'))
  expect(executions).toBe(4)
})

test('CSRF rejection precedes handler work and security headers also apply to rejection responses', async () => {
  let writes = 0
  const handler = HttpEffect.toWebHandler(
    Effect.sync(() => {
      writes++
      return HttpServerResponse.empty({ status: 204 })
    }).pipe(Csrf.middleware(), SecureHeaders.middleware()),
  )
  const denied = await handler(
    new Request('https://example.com/write', {
      method: 'POST',
      headers: { origin: 'https://attacker.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    }),
  )
  expect(denied.status).toBe(403)
  expect(denied.headers.get('cache-control')).toBe('no-store')
  expect(denied.headers.get('x-frame-options')).toBe('DENY')
  expect(writes).toBe(0)
  const allowed = await handler(
    new Request('https://example.com/write', { method: 'POST', headers: { origin: 'https://example.com' } }),
  )
  expect(allowed.status).toBe(204)
  expect(writes).toBe(1)
})
