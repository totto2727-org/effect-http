import { live } from '@effect/vitest'
import { Context, Effect, Result, Schema } from 'effect'
import { Headers, HttpClientRequest, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import * as Csrf from './csrf.ts'

const decodeString = Schema.decodeUnknownResult(Schema.String)

const target = 'https://app.example/action'
const request = { method: 'POST', url: target }

describe('csrf pure decisions', () => {
  test.each(['GET', 'HEAD', 'OPTIONS', 'get'])('bypasses safe %s', (method) => {
    expect(Csrf.decide({ method, url: '', origin: 'null', secFetchSite: 'cross-site' })).toStrictEqual({
      allowed: true,
    })
  })

  test.each(['POST', 'PUT', 'PATCH', 'DELETE', 'CUSTOM'])('requires proof for %s', (method) => {
    expect(Csrf.decide({ ...request, method })).toStrictEqual({ allowed: false, reason: 'missing-proof' })
  })

  test('normalizes exact origins without suffix matching', () => {
    expect(Csrf.decide({ ...request, origin: 'https://APP.example:443' })).toStrictEqual({ allowed: true })
    expect(Csrf.decide({ ...request, origin: 'https://app.example.evil' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'http://app.example' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'https://app.example:444' }).allowed).toBe(false)
  })

  test.each([
    'null',
    '',
    'https://app.example/path',
    'https://app.example\u007f',
    'https://user@app.example',
    'https://app.example?x',
    'https://app.example#x',
    'https://app.example https://evil.example',
    'https://app.example\r\nx: y',
    'data:text/plain,test',
  ])('rejects malformed Origin %j', (origin) => {
    expect(Csrf.decide({ ...request, origin, secFetchSite: 'same-origin' })).toStrictEqual({
      allowed: false,
      reason: 'invalid-origin',
    })
  })

  test.each([
    'https://app.example/path/..',
    'https://@app.example',
    'https:\\app.example',
    'https://app.example\t',
    'https://app.example?',
    'https://app.example#',
  ])('uses standard URL normalization for %j without authorizing a different origin', (origin) => {
    expect(Csrf.decide({ ...request, origin })).toStrictEqual({ allowed: true })
    expect(Csrf.decide({ ...request, origin: origin.replaceAll('app.example', 'evil.example') })).toStrictEqual({
      allowed: false,
      reason: 'untrusted-origin',
    })
  })

  test('does not let metadata override Origin and rejects contradictory claims', () => {
    expect(Csrf.decide({ ...request, origin: 'https://evil.example', secFetchSite: 'same-origin' }).allowed).toBe(false)
    expect(
      Csrf.decide(
        { ...request, origin: 'https://friend.example', secFetchSite: 'same-origin' },
        { allowedOrigins: ['https://friend.example'] },
      ),
    ).toStrictEqual({ allowed: false, reason: 'contradictory-metadata' })
    expect(Csrf.decide({ ...request, origin: 'https://app.example', secFetchSite: 'cross-site' }).allowed).toBe(false)
    expect(Csrf.decide({ ...request, origin: 'https://app.example', secFetchSite: 'garbage' }).allowed).toBe(false)
  })

  test('accepts an explicit cross-origin allowlist and same-origin metadata proof', () => {
    expect(
      Csrf.decide(
        { ...request, origin: 'https://FRIEND.example:443', secFetchSite: 'cross-site' },
        { allowedOrigins: ['https://friend.example/'] },
      ),
    ).toStrictEqual({ allowed: true })
    expect(Csrf.decide({ ...request, secFetchSite: 'same-origin' })).toStrictEqual({ allowed: true })
    for (const secFetchSite of ['same-site', 'cross-site', 'none'])
      expect(Csrf.decide({ ...request, secFetchSite }).allowed).toBe(false)
  })

  test.each(['*', 'null', 'https://example.com/path', 'https://example.com\r\nX: bad'])(
    'rejects invalid allowlist configuration %j',
    (origin) => {
      expect(() => Csrf.middleware({ allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
      expect(() => Csrf.decide(request, { allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
    },
  )

  test('rejects an invalid target even with metadata proof', () => {
    expect(Csrf.decide({ ...request, url: '/relative', secFetchSite: 'same-origin' })).toStrictEqual({
      allowed: false,
      reason: 'invalid-target',
    })
  })

  test('validates configuration first and evaluates target, origin, and metadata in that order', () => {
    expect(() => Csrf.decide({ method: 'GET', url: '' }, { allowedOrigins: ['null', '*'] })).toThrow(
      'Invalid allowed origin: null',
    )
    const invalidOrigin = { ...request, origin: 'null', secFetchSite: 'none' }
    expect(Csrf.decide({ ...invalidOrigin, url: '/relative' })).toStrictEqual({
      allowed: false,
      reason: 'invalid-target',
    })
    expect(Csrf.decide(invalidOrigin)).toStrictEqual({ allowed: false, reason: 'invalid-origin' })
    expect(Csrf.decide({ ...invalidOrigin, origin: 'https://evil.example' })).toStrictEqual({
      allowed: false,
      reason: 'untrusted-origin',
    })
  })

  test('requires and preserves the schema decoding cause on ConfigError', () => {
    const failure = decodeString(null)
    if (Result.isSuccess(failure)) throw new Error('expected schema failure')
    const cause = failure.failure
    const error = new Csrf.ConfigError({ message: 'invalid configuration', cause })
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ _tag: 'ConfigError', message: 'invalid configuration' })
    expect(error.cause).toBe(cause)
    expect(error.cause).toBeInstanceOf(Schema.SchemaError)
    // @ts-expect-error Schema decoding causes cannot be omitted.
    const withoutCause = () => new Csrf.ConfigError({ message: 'invalid configuration' })
    expect(withoutCause).toBeTypeOf('function')
    expect(() => Csrf.middleware({ allowedOrigins: ['null'] })).toThrow(
      expect.objectContaining({ cause: expect.any(Schema.SchemaError) }),
    )
  })
})

describe('csrf HTTP middleware', () => {
  test('denies JSON POST without executing the handler and prevents caching', async () => {
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

  test('passes accepted unsafe requests and merges Vary without duplicates', async () => {
    const app = Effect.succeed(
      HttpServerResponse.text('accepted', {
        status: 201,
        headers: { vary: 'sec-fetch-site, Accept, origin, 10, X-Custom, 2, , aCCEPT, ORIGIN, 10, __proto__' },
      }),
    )
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, { method: 'DELETE', headers: { origin: 'https://app.example' } }),
    )
    expect(response.status).toBe(201)
    await expect(response.text()).resolves.toBe('accepted')
    expect(response.headers.get('vary')).toBe('Sec-Fetch-Site, aCCEPT, Origin, 10, X-Custom, 2, __proto__')
  })

  test('does not trust forwarded host or protocol, or permit evil Origin with same-origin metadata', async () => {
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

  live('accepts relative HTTP targets and honors HTTPS without trusting forwarding headers', () =>
    Effect.gen(function* () {
      const app = Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
      const respond = (request: HttpServerRequest.HttpServerRequest) =>
        Effect.provideService(app, HttpServerRequest.HttpServerRequest, request)
      const http = HttpServerRequest.fromClientRequest(
        HttpClientRequest.post('/action', {
          headers: { host: 'app.example', origin: 'http://app.example', 'x-forwarded-proto': 'https' },
        }),
      )
      const https = HttpServerRequest.fromClientRequest(
        HttpClientRequest.post('/action', { headers: { host: 'app.example', origin: 'https://app.example' } }),
      ).modify({ protocol: 'https' })
      const untrusted = https.modify({
        headers: Headers.fromInput({ host: 'app.example', origin: 'https://evil.example' }),
      })
      const httpResponse = yield* respond(http)
      const httpsResponse = yield* respond(https)
      const rejectedResponse = yield* respond(untrusted)
      expect([httpResponse.status, httpsResponse.status, rejectedResponse.status]).toStrictEqual([204, 204, 403])
    }),
  )

  live.each([
    { url: '//evil.example/action', host: 'app.example', origin: 'http://app.example', status: 204 },
    { url: '//evil.example/action', host: 'app.example', origin: 'http://evil.example', status: 403 },
    { url: '/action', origin: 'http://localhost', status: 403 },
    { url: '/action', host: '[invalid', origin: 'http://app.example', status: 403 },
    { url: target, host: 'evil.example', origin: 'https://app.example', status: 204 },
    { url: target, host: 'evil.example', origin: 'https://evil.example', status: 403 },
    { url: target, origin: 'https://app.example', status: 204 },
  ])('delegates request URL resolution without changing the trusted authority: %j', (input) =>
    Effect.gen(function* () {
      const app = Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
      const headers = { origin: input.origin, ...(input.host ? { host: input.host } : {}) }
      const serverRequest = HttpServerRequest.fromClientRequest(HttpClientRequest.post(input.url, { headers }))
      const response = yield* Effect.provideService(app, HttpServerRequest.HttpServerRequest, serverRequest)
      expect(response.status).toBe(input.status)
    }),
  )

  test('retains wildcard Vary', async () => {
    const handler = HttpEffect.toWebHandler(
      Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ headers: { vary: 'Accept, *, origin' } }))),
    )
    expect((await handler(new Request(target))).headers.get('vary')).toBe('Accept, *, origin')
  })

  test('preserves error and environment types', () => {
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
