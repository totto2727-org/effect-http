import { Context, Effect, Record } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import * as SecureHeaders from './secure-headers.ts'

describe('secureHeaders pure policies', () => {
  test.each(["'self'\n", "'self'\r", "'self'\r\n"])('rejects terminal CSP controls: %j', (value) => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'default-src': [value] })).toThrow(
      SecureHeaders.ConfigError,
    )
  })

  test('has compact document-isolation defaults without HTTPS or CSP assumptions', () => {
    expect(Object.isFrozen(SecureHeaders.headers())).toBe(true)
    expect(SecureHeaders.headers()).toStrictEqual({
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
  })

  test('supports explicit resource sharing, popup compatibility, and omitted policies', () => {
    expect(
      SecureHeaders.headers({
        crossOriginOpenerPolicy: 'same-origin-allow-popups',
        crossOriginResourcePolicy: 'cross-origin',
        frameOptions: false,
        referrerPolicy: 'same-origin',
      }),
    ).toStrictEqual({
      'cross-origin-opener-policy': 'same-origin-allow-popups',
      'cross-origin-resource-policy': 'cross-origin',
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    })
  })
})

describe('csp and hsts serialization', () => {
  test('serializes typed static CSP and opt-in HSTS', () => {
    expect(
      SecureHeaders.serializeContentSecurityPolicy(
        Record.fromEntries([
          ['default-src', ["'self'"]],
          ['object-src', ["'none'"]],
          ['img-src', ["'self'", 'https://images.example']],
          ['upgrade-insecure-requests', []],
          ['sandbox', []],
        ]),
      ),
    ).toBe(
      "default-src 'self'; object-src 'none'; img-src 'self' https://images.example; upgrade-insecure-requests; sandbox",
    )
    expect(
      SecureHeaders.headers({ hsts: { includeSubDomains: true, maxAge: 31_536_000, preload: true } })[
        'strict-transport-security'
      ],
    ).toBe('max-age=31536000; includeSubDomains; preload')
    expect(SecureHeaders.headers({ hsts: { maxAge: 0 } })['strict-transport-security']).toBe('max-age=0')
  })

  test.each([
    'https://safe.example; script-src *',
    'https://safe.example\r\nX: injected',
    "'self' *",
    'a,b',
    'a\n',
    'é',
    '',
  ])('rejects CSP token injection %j', (value) => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'default-src': [value] })).toThrow(
      SecureHeaders.ConfigError,
    )
  })
})

describe('security header input validation', () => {
  test('rejects unknown directives, empty policies, invalid boolean directives, and none mixtures', () => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({})).toThrow(SecureHeaders.ConfigError)
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'default-src': [] })).toThrow(SecureHeaders.ConfigError)
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'upgrade-insecure-requests': ['*'] })).toThrow(
      SecureHeaders.ConfigError,
    )
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'script-src': ["'none'", '*'] })).toThrow(
      SecureHeaders.ConfigError,
    )
    // @ts-expect-error Unknown directives must be rejected by both the type system and runtime.
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'default-src; script-src': ['*'] })).toThrow(
      SecureHeaders.ConfigError,
    )
  })

  test('reports malformed inputs before otherwise inapplicable CSP and HSTS features', () => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'upgrade-insecure-requests': [';'] })).toThrow(
      'Invalid CSP value for upgrade-insecure-requests',
    )
    // @ts-expect-error JavaScript callers can supply an invalid flag even for a valid age.
    expect(() => SecureHeaders.headers({ hsts: { includeSubDomains: 'true', maxAge: 1, preload: true } })).toThrow(
      'Invalid HSTS configuration',
    )
  })

  test('validates policy enums even when JavaScript callers bypass TypeScript', () => {
    // @ts-expect-error Header injection is not a policy enum member.
    expect(() => SecureHeaders.middleware({ referrerPolicy: 'no-referrer\r\nInjected: yes' })).toThrow(
      SecureHeaders.ConfigError,
    )
    // @ts-expect-error Invalid frame policy is not accepted.
    expect(() => SecureHeaders.headers({ frameOptions: 'ALLOWALL' })).toThrow(SecureHeaders.ConfigError)
  })
})

describe('hsts age and preload constraints', () => {
  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid HSTS age %j',
    (maxAge) => {
      expect(() => SecureHeaders.middleware({ hsts: { maxAge } })).toThrow(SecureHeaders.ConfigError)
    },
  )

  test('rejects preload without its prerequisites', () => {
    expect(() => SecureHeaders.headers({ hsts: { includeSubDomains: true, maxAge: 10, preload: true } })).toThrow(
      SecureHeaders.ConfigError,
    )
    expect(() => SecureHeaders.headers({ hsts: { maxAge: 31_536_000, preload: true } })).toThrow(
      SecureHeaders.ConfigError,
    )
  })
})

describe('secureHeaders HTTP middleware', () => {
  test('applies defaults, overrides insecure app values, and removes X-Powered-By', async () => {
    const app = Effect.succeed(
      HttpServerResponse.text('body', {
        headers: { 'x-custom': 'kept', 'x-frame-options': 'ALLOWALL', 'x-powered-by': 'framework' },
        status: 202,
      }),
    )
    const response = await HttpEffect.toWebHandler(SecureHeaders.middleware()(app))(new Request('https://app.example'))
    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe('body')
    const { headers } = response
    const defaults = SecureHeaders.headers()
    expect(Record.map(defaults, (_value, name) => headers.get(name))).toStrictEqual(defaults)
    expect({
      contentSecurityPolicy: headers.has('content-security-policy'),
      custom: headers.get('x-custom'),
      hsts: headers.has('strict-transport-security'),
      poweredBy: headers.has('x-powered-by'),
    }).toStrictEqual({ contentSecurityPolicy: false, custom: 'kept', hsts: false, poweredBy: false })
  })
})

describe('configured middleware', () => {
  test('applies opt-in CSP and HSTS to real responses', async () => {
    const middleware = SecureHeaders.middleware({
      contentSecurityPolicy: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      hsts: { maxAge: 600 },
    })
    const denied = Effect.succeed(HttpServerResponse.empty({ status: 403 }))
    const handler = HttpEffect.toWebHandler(middleware(denied))
    const response = await handler(new Request('https://app.example'))
    expect(response.status).toBe(403)
    expect(response.headers.get('strict-transport-security')).toBe('max-age=600')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })

  test('snapshots mutable configuration at middleware construction', async () => {
    const sources = ["'self'"]
    const policy = SecureHeaders.middleware({ contentSecurityPolicy: { 'default-src': sources } })
    sources.push('*')
    const app = Effect.succeed(HttpServerResponse.empty())
    const handler = HttpEffect.toWebHandler(policy(app))
    const response = await handler(new Request('https://app.example'))
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'")
  })

  test('preserves error and environment types', () => {
    class Service extends Context.Service<Service, Readonly<{ value: string }>>()('SecureHeadersTestService') {}
    const app: Effect.Effect<HttpServerResponse.HttpServerResponse, 'failure', Service> = Effect.flatMap(Service, () =>
      Effect.fail('failure' as const),
    )
    const wrapped: Effect.Effect<HttpServerResponse.HttpServerResponse, 'failure', Service> =
      SecureHeaders.middleware()(app)
    expect(wrapped).toBeDefined()
  })
})
