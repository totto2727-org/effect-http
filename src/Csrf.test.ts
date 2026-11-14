import { Context, Effect } from 'effect'
import { Headers, HttpClientRequest, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import { Csrf } from './index.ts'

const target = 'https://app.example/action'
const request = { method: 'POST', url: target }

describe('Csrf pure decisions', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('bypasses safe %s', (method) => {
    expect(Csrf.decide({ method, url: '', origin: 'null', secFetchSite: 'cross-site' })).toEqual({ allowed: true })
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'CUSTOM'])('requires proof for %s', (method) => {
    expect(Csrf.decide({ ...request, method })).toEqual({ allowed: false, reason: 'missing-proof' })
  })
  it('normalizes exact origins without suffix matching', () => {
    expect(Csrf.decide({ ...request, origin: 'https://APP.example:443' })).toEqual({ allowed: true })
    expect(Csrf.decide({ ...request, origin: 'https://app.example.evil' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'http://app.example' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'https://app.example:444' }).allowed).toBe(false)
  })
  it.each([
    'null',
    '',
    'https://app.example/path',
    'https://user@app.example',
    'https://@app.example',
    'https://app.example?x',
    'https://app.example#x',
    'https://app.example https://evil.example',
    'https://app.example\r\nx: y',
    'https:\\app.example',
    'data:text/plain,test',
  ])('rejects malformed Origin %j', (origin) => {
    expect(Csrf.decide({ ...request, origin, secFetchSite: 'same-origin' })).toEqual({
      allowed: false,
      reason: 'invalid-origin',
    })
  })
  it('does not let metadata override Origin and rejects contradictory claims', () => {
    expect(Csrf.decide({ ...request, origin: 'https://evil.example', secFetchSite: 'same-origin' }).allowed).toBe(false)
    expect(
      Csrf.decide(
        { ...request, origin: 'https://friend.example', secFetchSite: 'same-origin' },
        { allowedOrigins: ['https://friend.example'] },
      ),
    ).toEqual({ allowed: false, reason: 'contradictory-metadata' })
    expect(Csrf.decide({ ...request, origin: 'https://app.example', secFetchSite: 'cross-site' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'https://app.example', secFetchSite: 'garbage' }).allowed).toBe(false)
  })
  it('accepts an explicit cross-origin allowlist and same-origin metadata proof', () => {
    expect(
      Csrf.decide(
        { ...request, origin: 'https://FRIEND.example:443', secFetchSite: 'cross-site' },
        { allowedOrigins: ['https://friend.example/'] },
      ),
    ).toEqual({ allowed: true })
    expect(Csrf.decide({ ...request, secFetchSite: 'same-origin' })).toEqual({ allowed: true })
    for (const secFetchSite of ['same-site', 'cross-site', 'none'])
      expect(Csrf.decide({ ...request, secFetchSite }).allowed).toBe(false)
  })
  it.each(['*', 'null', 'https://example.com/path', 'https://example.com\r\nX: bad'])(
    'rejects invalid allowlist configuration %j',
    (origin) => {
      expect(() => Csrf.middleware({ allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
      expect(() => Csrf.decide(request, { allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
    },
  )
  it('rejects an invalid target even with metadata proof', () => {
    expect(Csrf.decide({ ...request, url: '/relative', secFetchSite: 'same-origin' })).toEqual({
      allowed: false,
      reason: 'invalid-target',
    })
  })
})

describe('Csrf HTTP middleware', () => {
  it('denies JSON POST without executing the handler and prevents caching', async () => {
    const app = Effect.sync(() => {
      throw new Error('handler must not execute')
    })
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('vary')).toBe('Origin, Sec-Fetch-Site')
  })
  it('passes accepted unsafe requests and merges Vary without duplicates', async () => {
    const app = Effect.succeed(
      HttpServerResponse.text('accepted', { status: 201, headers: { vary: 'Accept, origin' } }),
    )
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, { method: 'DELETE', headers: { origin: 'https://app.example' } }),
    )
    expect(response.status).toBe(201)
    expect(await response.text()).toBe('accepted')
    expect(response.headers.get('vary')).toBe('Accept, Origin, Sec-Fetch-Site')
  })
  it('does not trust forwarded host or protocol, or permit evil Origin with same-origin metadata', async () => {
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(Effect.succeed(HttpServerResponse.text('unsafe'))))
    const response = await handler(
      new Request(target, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
          forwarded: 'host=evil.example;proto=https',
        },
      }),
    )
    expect(response.status).toBe(403)
  })
  it('accepts relative HTTP targets and honors an explicitly supplied HTTPS protocol without trusting forwarding headers', async () => {
    const app = Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
    const http = HttpServerRequest.fromClientRequest(
      HttpClientRequest.post('/action', {
        headers: { host: 'app.example', origin: 'http://app.example', 'x-forwarded-proto': 'https' },
      }),
    )
    expect(
      (await Effect.runPromise(app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, http)))).status,
    ).toBe(204)
    const https = HttpServerRequest.fromClientRequest(
      HttpClientRequest.post('/action', { headers: { host: 'app.example', origin: 'https://app.example' } }),
    ).modify({ protocol: 'https' })
    expect(
      (await Effect.runPromise(app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, https)))).status,
    ).toBe(204)
    expect(
      (
        await Effect.runPromise(
          app.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              https.modify({ headers: Headers.fromInput({ host: 'app.example', origin: 'https://evil.example' }) }),
            ),
          ),
        )
      ).status,
    ).toBe(403)
  })
  it('retains wildcard Vary', async () => {
    const handler = HttpEffect.toWebHandler(
      Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ headers: { vary: '*' } }))),
    )
    expect((await handler(new Request(target))).headers.get('vary')).toBe('*')
  })
  it('preserves error and environment types', () => {
    class Service extends Context.Service<Service, { readonly value: string }>()('CsrfTestService') {}
    const app: Effect.Effect<HttpServerResponse.HttpServerResponse, 'failure', Service> = Effect.flatMap(Service, () =>
      Effect.fail('failure' as const),
    )
    const wrapped: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      'failure',
      Service | HttpServerRequest.HttpServerRequest
    > = Csrf.middleware()(app)
    expect(wrapped).toBeDefined()
  })
})
