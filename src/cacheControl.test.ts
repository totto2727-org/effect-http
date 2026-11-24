import { Array, Effect, Result, String } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as CacheControl from './cacheControl.ts'

describe('cache-control directives', () => {
  test.each(['public\n', 'max-age=1\r', 'public\r\n'])('rejects terminal header controls: %j', (input) => {
    expect(Result.isFailure(CacheControl.parse(input))).toBe(true)
  })

  test('parses and formats typed directives', () => {
    const parsed = CacheControl.parse('public, max-age="60", immutable')
    expect(Result.isSuccess(parsed) && parsed.success).toStrictEqual({ public: true, maxAge: 60, immutable: true })
    expect(CacheControl.format({ maxStale: true, maxAge: 60, immutable: true, public: true })).toBe(
      'public, immutable, max-age=60, max-stale',
    )
  })

  test.each([
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

  test.each([
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

  test.each([
    ['public, private, ,', 'Malformed directive'],
    ['max-age=1, MAX-AGE', 'Duplicate max-age'],
    ['max-age=1, MAX-AGE="x"', 'Malformed directive'],
    ['max-age=1, MAX-AGE=9007199254740992', 'Duplicate max-age'],
    ['no-store=9007199254740992', 'Unexpected value for no-store'],
    ['max-age=9007199254740992', 'Invalid seconds'],
    ['max-age=', 'Malformed directive'],
    ['\t ', 'Empty Cache-Control'],
    ['unknown, max-age', 'Unsupported directive unknown'],
    ['public, private', 'Conflicting visibility'],
  ])('reports the first error for %s', (input, reason) => {
    const err = Result.getOrThrow(Result.flip(CacheControl.parse(input)))
    expect(err).toBeInstanceOf(CacheControl.ParseError)
    expect(err.reason).toBe(reason)
  })

  test('accepts HTTP optional whitespace', () => {
    const parsed = CacheControl.parse('\tpublic ,\tmax-age=60\t')
    expect(Result.isSuccess(parsed) && parsed.success).toStrictEqual({ public: true, maxAge: 60 })
  })

  test('applies the header size and directive count ceilings before parsing directive semantics', () => {
    const parseError = (input: string) => Result.getOrThrow(Result.flip(CacheControl.parse(input))).reason
    expect(Result.getOrThrow(CacheControl.parse(`public${String.repeat(8186)(' ')}`))).toStrictEqual({ public: true })
    expect(parseError(`public${String.repeat(8187)(' ')}`)).toBe('Invalid header bytes or length')
    expect(parseError(String.repeat(64)('public,') + 'public')).toBe('Too many directives')
    expect(parseError(String.repeat(63)('public,') + 'public')).toBe('Duplicate public')
  })

  test('preserves parsed seconds as readonly numbers distinct from unvalidated config input', () => {
    const parsed = Result.getOrThrow(CacheControl.parse('max-age="00060", min-fresh=9007199254740991, max-stale'))
    expect(parsed).toStrictEqual({ maxAge: 60, minFresh: 9007199254740991, maxStale: true })
    expectTypeOf(parsed.maxAge).toExtend<number | undefined>()
    expectTypeOf<number>().not.toExtend<typeof parsed.maxAge>()
    expect(CacheControl.format(parsed)).toBe('max-age=60, min-fresh=9007199254740991, max-stale')
  })

  test('rejects invalid output configuration', () => {
    expect(() => CacheControl.format({ maxAge: -1 })).toThrow(CacheControl.ConfigError)
  })

  test('sets policy on an observable response', async () => {
    const handler = HttpEffect.toWebHandler(
      CacheControl.middleware({ noStore: true })(Effect.succeed(HttpServerResponse.text('ok'))),
    )
    const response = await handler(new Request('https://example.com/'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.text()).resolves.toBe('ok')
  })
})
