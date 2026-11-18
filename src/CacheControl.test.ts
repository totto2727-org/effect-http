import { Array, Effect, Result, String } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { describe, expect, it } from 'vite-plus/test'

import { CacheControl } from './index.ts'

describe('CacheControl', () => {
  it('parses and formats typed directives', () => {
    const parsed = CacheControl.parse('public, max-age="60", immutable')
    expect(Result.isSuccess(parsed) && parsed.success).toEqual({ public: true, maxAge: 60, immutable: true })
    expect(CacheControl.format({ maxStale: true, maxAge: 60, immutable: true, public: true })).toBe(
      'public, immutable, max-age=60, max-stale',
    )
  })
  it.each([
    'max-age=1, max-age=2',
    'public, private',
    'max-age=-1',
    'max-age=9007199254740992',
    'no-store=1',
    'no-cache="x"',
    'max-age=1,',
    'unknown=1',
  ])('rejects unsafe policy %s', (input) => {
    expect(Result.isFailure(CacheControl.parse(input))).toBe(true)
  })
  it.each([
    'no-store\n',
    '\rno-store',
    'no-store\u00a0',
    'no-store\u000b',
    String.repeat(8193)('x'),
    Array.join(
      Array.makeBy(65, (i) => `x${i}`),
      ',',
    ),
  ])('rejects oversized or non-HTTP header syntax %#', (input) => {
    expect(Result.isFailure(CacheControl.parse(input))).toBe(true)
  })
  it.each([
    ['public, private, ,', 'Malformed directive'],
    ['max-age=1, MAX-AGE', 'Duplicate max-age'],
    ['unknown, max-age', 'Unsupported directive unknown'],
    ['public, private', 'Conflicting visibility'],
  ])('reports the first error for %s', (input, reason) => {
    const err = Result.getOrThrow(Result.flip(CacheControl.parse(input)))
    expect(err).toBeInstanceOf(CacheControl.ParseError)
    expect(err.reason).toBe(reason)
  })
  it('accepts HTTP optional whitespace', () => {
    const parsed = CacheControl.parse('\tpublic ,\tmax-age=60\t')
    expect(Result.isSuccess(parsed) && parsed.success).toEqual({ public: true, maxAge: 60 })
  })
  it('rejects invalid output configuration', () => {
    expect(() => CacheControl.format({ maxAge: -1 })).toThrow(CacheControl.ConfigError)
  })
  it('sets policy on an observable response', async () => {
    const handler = HttpEffect.toWebHandler(
      CacheControl.middleware({ noStore: true })(Effect.succeed(HttpServerResponse.text('ok'))),
    )
    const response = await handler(new Request('https://example.com/'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('ok')
  })
})
