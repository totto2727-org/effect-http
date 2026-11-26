import type { Option } from 'effect'
import { Array, Data, DateTime, String } from 'effect'
import type { Etag } from 'effect/http'
import { Headers, HttpServerResponse } from 'effect/http'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as ConditionalRequest from './conditional-request.ts'
import type * as HttpDate from './internal/http-date.ts'

const Tags = Data.taggedEnum<Etag.Etag>()
const etag = Tags.Strong({ value: 'a,b' })
const representationDate = DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01'))
// oxlint-disable-next-line rules/no-js-date -- Exercise the public validator boundary with an invalid native Date.
const invalidDate = new Date(Number.NaN)
const oversizedTag = `"${String.repeat(8192)('x')}"`

describe('conditional requests', () => {
  test('distinguishes parsed values from unchecked input without breaking Effect interoperability', () => {
    type ParsedEtag = NonNullable<ReturnType<typeof ConditionalRequest.parseEtag>>
    type ParsedDate = Option.Option.Value<ReturnType<typeof HttpDate.parse>>
    expectTypeOf<ParsedEtag>().toExtend<Etag.Etag>()
    expectTypeOf<string>().not.toExtend<ParsedEtag['value']>()
    expectTypeOf<ParsedDate>().toExtend<DateTime.Utc>()
    expectTypeOf<DateTime.Utc>().not.toExtend<ParsedDate>()
    expectTypeOf<string>().not.toExtend<ParsedDate>()
  })

  test('parses Effect tags and distinguishes weak and strong comparison', () => {
    expect(ConditionalRequest.parseEtag('W/"a,b"')).toStrictEqual(Tags.Weak({ value: 'a,b' }))
    expect(ConditionalRequest.parseEtag('"bad\n"')).toBeUndefined()
    expect(ConditionalRequest.matches(etag, Tags.Weak({ value: 'a,b' }))).toBe(true)
    expect(ConditionalRequest.matches(etag, Tags.Weak({ value: 'a,b' }), true)).toBe(false)
  })

  test.each(['GET', 'HEAD'])('returns 304 for weak matching %s retrieval', (method) => {
    expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': '"other", W/"a,b"' }, method })).toBe(
      'NotModified',
    )
  })

  test('protects unsafe writes through pre-handler evaluation', () => {
    expect(ConditionalRequest.evaluate({ etag, headers: { 'if-match': 'W/"a,b"' }, method: 'PUT' })).toBe(
      'PreconditionFailed',
    )
    expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': '*' }, method: 'PUT' })).toBe(
      'PreconditionFailed',
    )
    expect(ConditionalRequest.evaluate({ exists: false, headers: { 'if-none-match': '*' }, method: 'PUT' })).toBe(
      'Proceed',
    )
  })
})

describe('entity tag wire syntax and bounds', () => {
  test('does not turn malformed lists into a match', () => {
    expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': '"a,b",' }, method: 'GET' })).toBe('Proceed')
  })

  test.each(['"a,b", garbage', 'garbage, "a,b"', '"a,b",,"other"', '"a,b" , \t'])(
    'rejects an entire malformed list even when it contains a match: %s',
    (value) => {
      expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': value }, method: 'GET' })).toBe('Proceed')
      expect(ConditionalRequest.evaluate({ etag, headers: { 'if-match': value }, method: 'PUT' })).toBe(
        'PreconditionFailed',
      )
    },
  )

  test('accepts 64 quoted tags, including opaque commas, without accepting a 65th', () => {
    const allowed = Array.join([...Array.replicate('"other"', 63), 'W/"a,b"'], ',')
    expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': allowed }, method: 'GET' })).toBe(
      'NotModified',
    )
    expect(
      ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': `${allowed},"last"` }, method: 'GET' }),
    ).toBe('Proceed')
  })

  test('counts the entire ETag including quotes and the weak prefix at the byte limit', () => {
    const opaque = String.repeat(8188)('é')
    expect(ConditionalRequest.parseEtag(`W/"${opaque}"`)).toStrictEqual(Tags.Weak({ value: opaque }))
    expect(ConditionalRequest.parseEtag(`W/"${opaque}x"`)).toBeUndefined()
    expect(ConditionalRequest.parseEtag(`"${opaque}xx"`)).toStrictEqual(Tags.Strong({ value: `${opaque}xx` }))
    expect(ConditionalRequest.parseEtag('""')).toStrictEqual(Tags.Strong({ value: '' }))
  })

  test.each(['"a,b", "bad tag"', '"a,b", "bad\ttag"', '"a,b", w/"other"', '"a,b", "\u007F"', '"a,b", "Ā"'])(
    'rejects a match followed by a token with invalid wire format: %s',
    (value) => {
      expect(ConditionalRequest.evaluate({ etag, headers: { 'if-match': value }, method: 'PUT' })).toBe(
        'PreconditionFailed',
      )
    },
  )
})

describe('validator configuration and date precedence', () => {
  test('throws generated configuration errors rather than plain errors', () => {
    expect(() => ConditionalRequest.middleware({ maxBodyBytes: -1 })).toThrow(ConditionalRequest.ConfigError)
    expect(() =>
      ConditionalRequest.apply(
        HttpServerResponse.text('body'),
        { headers: Headers.empty, method: 'GET' },
        {
          etag: Tags.Strong({ value: 'bad"tag' }),
        },
      ),
    ).toThrow(ConditionalRequest.ConfigError)
    expect(() =>
      ConditionalRequest.apply(
        HttpServerResponse.text('body'),
        { headers: Headers.empty, method: 'GET' },
        {
          lastModified: invalidDate,
        },
      ),
    ).toThrow(ConditionalRequest.ConfigError)
  })

  test('gives If-None-Match precedence over modification time', () => {
    expect(
      ConditionalRequest.evaluate({
        etag,
        headers: { 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT', 'if-none-match': '"other"' },
        lastModified: representationDate,
        method: 'GET',
      }),
    ).toBe('Proceed')
  })

  test.each(['"a,b"\n', '"a,b"\r', oversizedTag])('rejects non-exact or oversized ETags %#', (value) => {
    expect(ConditionalRequest.parseEtag(value)).toBeUndefined()
  })

  test.each(['"a,b"\n', '\u00A0"a,b"', Array.join(Array.replicate('"a,b"', 65), ','), oversizedTag])(
    'never matches malformed or oversized lists %#',
    (value) => {
      expect(ConditionalRequest.evaluate({ etag, headers: { 'if-none-match': value }, method: 'GET' })).toBe('Proceed')
    },
  )
})

describe('invalid modification dates', () => {
  test.each([
    'Tue, 31 Feb 2026 00:00:00 GMT',
    'Mon, 01 Jan 2025 00:00:00 GMT',
    'Wed, 01 Jan 2025 00:00:00 GMT\n',
    'Wed, 01 Jan 2025 24:00:00 GMT',
  ])('ignores invalid HTTP dates %#', (value) => {
    expect(
      ConditionalRequest.evaluate({
        headers: { 'if-modified-since': value },
        lastModified: representationDate,
        method: 'GET',
      }),
    ).toBe('Proceed')
  })

  test.each(['Sat, 01 Jan 0000 00:00:00 GMT', 'Mon, 01 Jan 0001 00:00:00 GMT', 'Thu, 01 Jan 0099 00:00:00 GMT'])(
    'ignores low-year preconditions without broadening the accepted date grammar: %s',
    (value) => {
      expect(
        ConditionalRequest.evaluate({
          headers: { 'if-unmodified-since': value },
          lastModified: representationDate,
          method: 'PUT',
        }),
      ).toBe('Proceed')
    },
  )
})
