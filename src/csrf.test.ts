import { live } from '@effect/vitest'
import { Context, Data, Effect, Predicate, Result, Schema } from 'effect'
import { Headers, HttpClientRequest, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as Csrf from './csrf.ts'

const decodeString = Schema.decodeUnknownResult(Schema.String)

const target = 'https://app.example/action'
const request = { method: 'POST', url: target }

describe('csrf pure decisions', () => {
  test.each(['GET', 'HEAD', 'OPTIONS', 'get'])('bypasses safe %s', (method) => {
    expect(Csrf.decide({ method, origin: 'null', secFetchSite: 'cross-site', url: '' })).toStrictEqual({
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
})

describe('origin syntax and normalization', () => {
  test.each([
    'null',
    '',
    'https://app.example/path',
    'https://app.example\u007F',
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
    String.raw`https:\app.example`,
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
})

describe('fetch metadata proof', () => {
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
  })

  test.each(['same-site', 'cross-site', 'none'])('rejects %s as the only proof', (secFetchSite) => {
    expect(Csrf.decide({ ...request, secFetchSite }).allowed).toBe(false)
  })
})

describe('allowlist and validation precedence', () => {
  test.each(['*', 'null', 'https://example.com/path', 'https://example.com\r\nX: bad'])(
    'rejects invalid allowlist configuration %j',
    (origin) => {
      expect(() => Csrf.middleware({ allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
      expect(() => Csrf.decide(request, { allowedOrigins: [origin] })).toThrow(Csrf.ConfigError)
    },
  )

  test('rejects an invalid target even with metadata proof', () => {
    expect(Csrf.decide({ ...request, secFetchSite: 'same-origin', url: '/relative' })).toStrictEqual({
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
})

describe('configuration error causes', () => {
  test('requires and preserves the schema decoding cause on ConfigError', () => {
    const cause = Result.getOrThrow(Result.flip(decodeString(42)))
    const error = new Csrf.ConfigError({ cause, message: 'invalid configuration' })
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('invalid configuration')
    expect(Predicate.isTagged(error, 'ConfigError')).toBe(true)
    expect(error.cause).toBe(cause)
    expectTypeOf<{ message: string }>().not.toExtend<ConstructorParameters<typeof Csrf.ConfigError>[0]>()
  })

  test('preserves a schema failure for an invalid configured origin', () => {
    const expectedCause: unknown = expect.any(Schema.SchemaError)
    expect(() => Csrf.middleware({ allowedOrigins: ['null'] })).toThrow(
      expect.objectContaining({ cause: expectedCause }),
    )
  })
})

const HandlerExecuted = Data.TaggedError('HandlerExecuted')

describe('csrf HTTP middleware', () => {
  test('denies JSON POST without executing the handler and prevents caching', async () => {
    const app = Effect.die(new HandlerExecuted<{ message: string }>({ message: 'handler must not execute' }))
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, { body: '{}', headers: { 'content-type': 'application/json' }, method: 'POST' }),
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('vary')).toBe('Origin, Sec-Fetch-Site')
  })

  test('passes accepted unsafe requests and merges Vary without duplicates', async () => {
    const app = Effect.succeed(
      HttpServerResponse.text('accepted', {
        headers: { vary: 'sec-fetch-site, Accept, origin, 10, X-Custom, 2, , aCCEPT, ORIGIN, 10, __proto__' },
        status: 201,
      }),
    )
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, { headers: { origin: 'https://app.example' }, method: 'DELETE' }),
    )
    expect(response.status).toBe(201)
    await expect(response.text()).resolves.toBe('accepted')
    expect(response.headers.get('vary')).toBe('Sec-Fetch-Site, aCCEPT, Origin, 10, X-Custom, 2, __proto__')
  })

  test('does not trust forwarded host or protocol, or permit evil Origin with same-origin metadata', async () => {
    const app = Effect.succeed(HttpServerResponse.text('unsafe'))
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(
      new Request(target, {
        headers: {
          forwarded: 'host=evil.example;proto=https',
          origin: 'https://evil.example',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
        method: 'POST',
      }),
    )
    expect(response.status).toBe(403)
  })
})

describe('relative request targets', () => {
  live('accepts relative HTTP targets and honors HTTPS without trusting forwarding headers', () =>
    Effect.gen(function* () {
      const app = Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
      const respond = (
        serverRequest: HttpServerRequest.HttpServerRequest,
      ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
        Effect.provideService(app, HttpServerRequest.HttpServerRequest, serverRequest)
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
})

describe('trusted target authority', () => {
  live.each([
    { host: 'app.example', origin: 'http://app.example', status: 204, url: '//evil.example/action' },
    { host: 'app.example', origin: 'http://evil.example', status: 403, url: '//evil.example/action' },
    { origin: 'http://localhost', status: 403, url: '/action' },
    { host: '[invalid', origin: 'http://app.example', status: 403, url: '/action' },
    { host: 'evil.example', origin: 'https://app.example', status: 204, url: target },
    { host: 'evil.example', origin: 'https://evil.example', status: 403, url: target },
    { origin: 'https://app.example', status: 204, url: target },
  ])('delegates request URL resolution without changing the trusted authority: %j', (input) =>
    Effect.gen(function* () {
      const app = Csrf.middleware()(Effect.succeed(HttpServerResponse.empty({ status: 204 })))
      const headers = { ...(Predicate.isNullish(input.host) ? {} : { host: input.host }), origin: input.origin }
      const serverRequest = HttpServerRequest.fromClientRequest(HttpClientRequest.post(input.url, { headers }))
      const response = yield* Effect.provideService(app, HttpServerRequest.HttpServerRequest, serverRequest)
      expect(response.status).toBe(input.status)
    }),
  )
})

describe('middleware response headers and types', () => {
  test('retains wildcard Vary', async () => {
    const app = Effect.succeed(HttpServerResponse.empty({ headers: { vary: 'Accept, *, origin' } }))
    const handler = HttpEffect.toWebHandler(Csrf.middleware()(app))
    const response = await handler(new Request(target))
    expect(response.headers.get('vary')).toBe('Accept, *, origin')
  })

  test('preserves error and environment types', () => {
    class Service extends Context.Service<Service, Readonly<{ value: string }>>()('CsrfTestService') {}
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
