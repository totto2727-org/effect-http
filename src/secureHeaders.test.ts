import { Context, Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, it } from 'vite-plus/test'

import * as SecureHeaders from './secureHeaders.ts'

describe('SecureHeaders pure policies', () => {
  it.each(["'self'\n", "'self'\r", "'self'\r\n"])('rejects terminal CSP controls: %j', (value) => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'default-src': [value] })).toThrow(
      SecureHeaders.ConfigError,
    )
  })
  it('has compact document-isolation defaults without HTTPS or CSP assumptions', () => {
    expect(Object.isFrozen(SecureHeaders.headers())).toBe(true)
    expect(SecureHeaders.headers()).toEqual({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    })
  })
  it('supports explicit resource sharing, popup compatibility, and omitted policies', () => {
    expect(
      SecureHeaders.headers({
        frameOptions: false,
        referrerPolicy: 'same-origin',
        crossOriginOpenerPolicy: 'same-origin-allow-popups',
        crossOriginResourcePolicy: 'cross-origin',
      }),
    ).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin-allow-popups',
      'cross-origin-resource-policy': 'cross-origin',
    })
  })
  it('serializes typed static CSP and opt-in HSTS', () => {
    expect(
      SecureHeaders.serializeContentSecurityPolicy({
        'default-src': ["'self'"],
        'object-src': ["'none'"],
        'img-src': ["'self'", 'https://images.example'],
        'upgrade-insecure-requests': [],
        sandbox: [],
      }),
    ).toBe(
      "default-src 'self'; object-src 'none'; img-src 'self' https://images.example; upgrade-insecure-requests; sandbox",
    )
    expect(
      SecureHeaders.headers({ hsts: { maxAge: 31536000, includeSubDomains: true, preload: true } })[
        'strict-transport-security'
      ],
    ).toBe('max-age=31536000; includeSubDomains; preload')
    expect(SecureHeaders.headers({ hsts: { maxAge: 0 } })['strict-transport-security']).toBe('max-age=0')
  })
  it.each([
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
  it('rejects unknown directives, empty policies, invalid boolean directives, and none mixtures', () => {
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
  it('reports malformed inputs before otherwise inapplicable CSP and HSTS features', () => {
    expect(() => SecureHeaders.serializeContentSecurityPolicy({ 'upgrade-insecure-requests': [';'] })).toThrow(
      'Invalid CSP value for upgrade-insecure-requests',
    )
    // @ts-expect-error JavaScript callers can supply an invalid flag even for a valid age.
    expect(() => SecureHeaders.headers({ hsts: { maxAge: 1, includeSubDomains: 'true', preload: true } })).toThrow(
      'Invalid HSTS configuration',
    )
  })
  it('validates policy enums even when JavaScript callers bypass TypeScript', () => {
    // @ts-expect-error Header injection is not a policy enum member.
    expect(() => SecureHeaders.middleware({ referrerPolicy: 'no-referrer\r\nInjected: yes' })).toThrow(
      SecureHeaders.ConfigError,
    )
    // @ts-expect-error Invalid frame policy is not accepted.
    expect(() => SecureHeaders.headers({ frameOptions: 'ALLOWALL' })).toThrow(SecureHeaders.ConfigError)
  })
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid HSTS age %j', (maxAge) => {
    expect(() => SecureHeaders.middleware({ hsts: { maxAge } })).toThrow(SecureHeaders.ConfigError)
  })
  it('rejects preload without its prerequisites', () => {
    expect(() => SecureHeaders.headers({ hsts: { maxAge: 10, includeSubDomains: true, preload: true } })).toThrow(
      SecureHeaders.ConfigError,
    )
    expect(() => SecureHeaders.headers({ hsts: { maxAge: 31536000, preload: true } })).toThrow(
      SecureHeaders.ConfigError,
    )
  })
})

describe('SecureHeaders HTTP middleware', () => {
  it('applies defaults, overrides insecure app values, and removes X-Powered-By', async () => {
    const app = Effect.succeed(
      HttpServerResponse.text('body', {
        status: 202,
        headers: { 'x-powered-by': 'framework', 'x-frame-options': 'ALLOWALL', 'x-custom': 'kept' },
      }),
    )
    const response = await HttpEffect.toWebHandler(SecureHeaders.middleware()(app))(new Request('https://app.example'))
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('body')
    expect(response.headers.get('x-powered-by')).toBeNull()
    expect(response.headers.get('x-custom')).toBe('kept')
    for (const [name, value] of Object.entries(SecureHeaders.headers())) expect(response.headers.get(name)).toBe(value)
    expect(response.headers.get('strict-transport-security')).toBeNull()
    expect(response.headers.get('content-security-policy')).toBeNull()
  })
  it('applies opt-in CSP and HSTS to real responses', async () => {
    const handler = HttpEffect.toWebHandler(
      SecureHeaders.middleware({
        hsts: { maxAge: 600 },
        contentSecurityPolicy: { 'default-src': ["'none'"], 'frame-ancestors': ["'none'"] },
      })(Effect.succeed(HttpServerResponse.empty({ status: 403 }))),
    )
    const response = await handler(new Request('https://app.example'))
    expect(response.status).toBe(403)
    expect(response.headers.get('strict-transport-security')).toBe('max-age=600')
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })
  it('snapshots mutable configuration at middleware construction', async () => {
    const sources = ["'self'"]
    const policy = SecureHeaders.middleware({ contentSecurityPolicy: { 'default-src': sources } })
    sources.push('*')
    const response = await HttpEffect.toWebHandler(policy(Effect.succeed(HttpServerResponse.empty())))(
      new Request('https://app.example'),
    )
    expect(response.headers.get('content-security-policy')).toBe("default-src 'self'")
  })
  it('preserves error and environment types', () => {
    class Service extends Context.Service<Service, { readonly value: string }>()('SecureHeadersTestService') {}
    const app: Effect.Effect<HttpServerResponse.HttpServerResponse, 'failure', Service> = Effect.flatMap(Service, () =>
      Effect.fail('failure' as const),
    )
    const wrapped: Effect.Effect<HttpServerResponse.HttpServerResponse, 'failure', Service> =
      SecureHeaders.middleware()(app)
    expect(wrapped).toBeDefined()
  })
})
