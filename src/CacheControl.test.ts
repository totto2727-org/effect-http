import { Effect } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { describe, expect, it } from 'vite-plus/test'

import { CacheControl } from './index.ts'

describe('CacheControl', () => {
  it('parses and formats typed directives', () => {
    expect(CacheControl.parse('public, max-age="60", immutable')).toEqual({
      _tag: 'Success',
      directives: { public: true, maxAge: 60, immutable: true },
    })
    expect(CacheControl.format({ public: true, maxAge: 60 })).toBe('public, max-age=60')
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
    expect(CacheControl.parse(input)._tag).toBe('Invalid')
  })
  it.each([
    'no-store\n',
    '\rno-store',
    'no-store\u00a0',
    'no-store\u000b',
    'x'.repeat(8193),
    Array.from({ length: 65 }, (_, i) => `x${i}`).join(','),
  ])('rejects oversized or non-HTTP header syntax %#', (input) => {
    expect(CacheControl.parse(input)._tag).toBe('Invalid')
  })
  it('accepts HTTP optional whitespace', () => {
    expect(CacheControl.parse('\tpublic ,\tmax-age=60\t')).toEqual({
      _tag: 'Success',
      directives: { public: true, maxAge: 60 },
    })
  })
  it('rejects invalid output configuration', () => {
    expect(() => CacheControl.format({ maxAge: -1 })).toThrow(TypeError)
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
