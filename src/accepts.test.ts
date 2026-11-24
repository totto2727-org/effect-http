import { Array, Option, Predicate, Result, String } from 'effect'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as Accepts from './accepts.ts'

const choose = (kind: Accepts.Kind, header: string | null | undefined, supports: Readonly<string[]>): string | null =>
  Option.getOrNull(Result.getOrThrow(Accepts.negotiate(kind, header, supports)))

const missingWebHeader = new globalThis.Headers().get('accept')
const missingEffectHeader = Option.getOrUndefined(Option.none<string>())
const canonicalUtf8 = new globalThis.TextDecoder().encoding
const preferenceWithParameters = (count: number): string => {
  const parameters = Array.makeBy(count, (index) => `;p${index}=x`)
  return `text/html${Array.join(parameters, '')}`
}

describe('accepts media negotiation', () => {
  test('uses specificity to determine effective quality before ranking offers', () => {
    expect(
      choose('mediaType', 'text/*;q=1,text/html;q=0.1,application/json;q=0.5', ['text/html', 'application/json']),
    ).toBe('application/json')
    expect(choose('mediaType', '*/*;q=1,text/*;q=0.2,text/html;q=0', ['text/html'])).toBeNull()
    expect(choose('mediaType', '*/*;q=1,text/*;q=0', ['text/plain'])).toBeNull()
  })
})

describe('accepts size and wire constraints', () => {
  test('accepts exactly the maximum header, offer, list and parameter sizes', () => {
    const longestCoding = String.repeat(8192)('x')
    expect(choose('encoding', longestCoding, [longestCoding])).toBe(longestCoding)
    const offers = Array.replicate('gzip', 128)
    const header = Array.join(offers, ',')
    expect(choose('encoding', header, offers)).toBe('gzip')

    const media = preferenceWithParameters(128)
    expect(choose('mediaType', media, [media])).toBe(media)
  })

  test.each(['gzip\n', 'gzip\r', 'gzip\0', 'gzipé'])(
    'rejects non-ASCII or forbidden control input %j at the boundary',
    (wire) => {
      const header = Accepts.parse('encoding', wire)
      const offer = Accepts.negotiate('encoding', missingWebHeader, [wire])
      const headerError = Result.getOrThrow(Result.flip(header))
      const offerError = Result.getOrThrow(Result.flip(offer))
      expect(headerError.reason).toBe('Invalid or oversized header')
      expect(offerError.reason).toBe('Invalid or oversized offer')
    },
  )

  test('requires validated values, parameters and qualities in parsed preferences', () => {
    expectTypeOf<string>().not.toExtend<Accepts.Preference['value']>()
    expectTypeOf<string>().not.toExtend<Accepts.Preference['parameters'][string]>()
    expectTypeOf<number>().not.toExtend<Accepts.Preference['quality']>()
    expectTypeOf<Accepts.Preference['value']>().toExtend<string>()
    expectTypeOf<Accepts.Preference['parameters'][string]>().toExtend<string>()
    expectTypeOf<Accepts.Preference['quality']>().toExtend<number>()
  })
})

describe('accepts media parameter specificity', () => {
  test('preserves offered casing and server order for equal qualities', () => {
    expect(choose('mediaType', 'TEXT/HTML,APPLICATION/JSON', ['Application/Json', 'text/html'])).toBe(
      'Application/Json',
    )
    expect(choose('mediaType', 'image/png', ['text/html'])).toBeNull()
    expect(choose('mediaType', '*/*', [])).toBeNull()
  })

  test('matches media parameters and their precedence, including quoted separators and escapes', () => {
    expect(
      choose('mediaType', 'text/html;level=1;q=0.1,text/html;q=0.8,application/json;q=0.5', [
        'text/html;level=1',
        'application/json',
      ]),
    ).toBe('application/json')
    expect(
      choose('mediaType', 'TEXT/HTML;CHARSET="UTF-8";profile="a,b;c\\\"d"', [
        'text/html;charset=utf-8;profile="a,b;c\\\"d"',
      ]),
    ).toBe('text/html;charset=utf-8;profile="a,b;c\\\"d"')
    expect(choose('mediaType', 'text/html;profile=UPPER', ['text/html;profile=upper'])).toBeNull()
    expect(choose('mediaType', 'text/html;level=1', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;level=1;q=0,text/html;q=1', ['text/html;level=1'])).toBeNull()
  })

  test('does not allow duplicate ranges to bypass a refusal', () => {
    expect(choose('mediaType', 'text/html;q=0,text/html;q=1,*/*', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;q=1,text/html;q=0,*/*', ['text/html'])).toBeNull()
  })
})

describe('accepts language, charset and encoding policies', () => {
  test('uses language basic filtering, with specific exclusions', () => {
    expect(choose('language', 'EN;q=0.7,fr;q=0.8', ['en-US', 'FR-ca'])).toBe('FR-ca')
    expect(choose('language', 'en-US', ['en'])).toBeNull()
    expect(choose('language', '*;q=1,en;q=0', ['en-US'])).toBeNull()
    expect(choose('language', 'en;q=1,en-US;q=0', ['en-US', 'en-GB'])).toBe('en-GB')
  })

  test('does not infer charset fallbacks', () => {
    expect(choose('charset', 'UTF-8;q=0,*;q=1', [canonicalUtf8, 'ISO-8859-1'])).toBe('ISO-8859-1')
    expect(choose('charset', 'utf-8;q=0', [canonicalUtf8])).toBeNull()
  })
})

describe('accepts encoding identity', () => {
  test.each([
    { expected: 'identity', header: 'gzip;q=0.5', offers: ['gzip', 'identity'] },
    { expected: 'identity', header: '*;q=0.5', offers: ['gzip', 'identity'] },
    { expected: missingWebHeader, header: '*;q=0', offers: ['gzip', 'identity'] },
    { expected: 'identity', header: 'identity;q=0.5,*;q=0', offers: ['gzip', 'identity'] },
    { expected: missingWebHeader, header: 'identity;q=0,*;q=1', offers: ['identity'] },
    { expected: 'br', header: 'gzip;q=0,*;q=1', offers: ['gzip', 'br'] },
    { expected: missingWebHeader, header: 'gzip', offers: ['br'] },
    { expected: 'identity', header: '', offers: ['gzip', 'identity'] },
  ])('negotiates encoding $header for $offers', ({ expected, header, offers }) => {
    expect(choose('encoding', header, offers)).toBe(expected)
  })
})

describe('missing and empty preference fields', () => {
  test.each([
    { kind: 'mediaType', offer: 'text/html' },
    { kind: 'language', offer: 'en' },
    { kind: 'charset', offer: 'en' },
    { kind: 'encoding', offer: 'en' },
  ] satisfies { kind: Accepts.Kind; offer: string }[])('distinguishes empty $kind from absence', ({ kind, offer }) => {
    const offers = [offer]
    expect(choose(kind, missingWebHeader, offers)).toBe(offer)
    expect(choose(kind, missingEffectHeader, offers)).toBe(offer)
    expect(Accepts.parse(kind, missingEffectHeader)).toStrictEqual(Accepts.parse(kind, missingWebHeader))
    expect(choose(kind, '', offers)).toBeNull()
    expect(choose(kind, ' \t ', offers)).toBeNull()
  })

  test('records whether an empty preference list was explicitly supplied', () => {
    expect(Accepts.parse('mediaType', missingWebHeader)).toStrictEqual(
      Result.succeed({ kind: 'mediaType', missing: true, preferences: [] }),
    )
    expect(Accepts.parse('mediaType', '')).toStrictEqual(
      Result.succeed({ kind: 'mediaType', missing: false, preferences: [] }),
    )
  })
})

describe('accepts strict parsing', () => {
  test.each([
    'text/html;q=2',
    'text/html;q=-1',
    'text/html;q=.5',
    'text/html;q=0.1234',
    'text/html;q=1.001',
    'text/html;q="0.5"',
    'text/html;q=NaN',
    'text/html;q=0;q=1',
    'text/html;q=0.5;extension=x',
    'text/html;level=1;LEVEL=2',
    'text/html;profile="unterminated',
    'text/html;profile="a"b"',
    globalThis.String.raw`text/html;profile="a\"`,
    'text/html,',
    ',text/html',
    'text/html,,text/plain',
    '*/html',
    'text',
    'text/h*ml',
    'text/html\r\nAccept: */*',
    'text/html\u0000',
    'text/html;name=é',
    'text/html;',
  ])('fails closed on malformed media input %s', (header) => {
    expect(Result.isFailure(Accepts.parse('mediaType', header))).toBe(true)
    expect(Result.isFailure(Accepts.negotiate('mediaType', header, ['text/html']))).toBe(true)
  })
})

describe('invalid offers and preference bounds', () => {
  test.each([
    ['language', 'en_US'],
    ['language', 'en;level=1'],
    ['encoding', 'gzip;level=1'],
    ['charset', 'utf-8;foo=bar'],
  ] satisfies [Accepts.Kind, string][])('rejects invalid %s field %j', (kind, header) => {
    expect(Result.isFailure(Accepts.parse(kind, header))).toBe(true)
  })

  test.each(['*/*', 'text/html;q=1', 'text/html,application/json', 'text/html\n'])(
    'rejects invalid media offer %j',
    (offer) => {
      expect(Result.isFailure(Accepts.negotiate('mediaType', '*/*', ['text/html', offer]))).toBe(true)
    },
  )

  test('rejects a wildcard language offer', () => {
    expect(Result.isFailure(Accepts.negotiate('language', '*', ['*']))).toBe(true)
  })

  test('enforces bounds without turning oversized input into a match', () => {
    const oversized = String.repeat(8193)('x')
    const tooMany = Array.replicate('gzip', 129)
    const oversizedList = Array.join(tooMany, ',')
    const oversizedPreference = preferenceWithParameters(129)
    const outcomes: Result.Result<unknown, Accepts.ParseError>[] = [
      Accepts.parse('mediaType', oversized),
      Accepts.parse('encoding', oversizedList),
      Accepts.negotiate('encoding', '*', tooMany),
      Accepts.negotiate('encoding', '*', [oversized]),
      Accepts.parse('mediaType', oversizedPreference),
    ]
    expect(Array.map(outcomes, Result.isFailure)).toStrictEqual([true, true, true, true, true])
  })
})

describe('validated preference details', () => {
  test('returns parsed parameters and numeric qualities', () => {
    expect(Accepts.parse('mediaType', 'TEXT/HTML;Charset="UTF-8";q=0.125')).toStrictEqual(
      Result.succeed({
        kind: 'mediaType',
        missing: false,
        preferences: [{ parameters: { charset: canonicalUtf8 }, quality: 0.125, value: 'text/html' }],
      }),
    )
  })

  test.each([
    ['text/html;q=2', Array.replicate('text/html', 129), 'Invalid quality'],
    ['text/html;q=2,text/html;p="unterminated', [], 'Invalid or excessive preference list'],
    ['text/html;q=2,text/html;bad', [], 'Invalid quality'],
    ['text/html;bad;q=2', [], 'Invalid parameter'],
    ['text/html;q=1;p="a"b"c"', [], 'Unsupported or duplicate parameter'],
    ['text/html', ['text/html', 'text/html;q=1', '\n'], 'Invalid quality'],
    ['text/html', ['text/html', '\n', 'text/html;q=1'], 'Invalid or oversized offer'],
  ] satisfies [string, Readonly<string[]>, string][])(
    'keeps the first failure for %s and %j',
    (header, offers, reason) => {
      const result = Accepts.negotiate('mediaType', header, offers)
      const error = Result.getOrThrow(Result.flip(result))
      expect(error).toMatchObject({ kind: 'mediaType', reason })
      expect(Predicate.isTagged(error, 'AcceptsParseError')).toBe(true)
      expect(error).toBeInstanceOf(Accepts.ParseError)
    },
  )
})

describe('escaped and prototype-named parameters', () => {
  test('keeps escaped quoted data and accepts prototype-named parameters as ordinary keys', () => {
    const offer = globalThis.String.raw`TEXT/HTML;profile="a,;\\\"b";__proto__=x;constructor=y`
    expect(choose('mediaType', `${offer};q=1.`, ['text/html', offer])).toBe(offer)
    const parsed = Accepts.parse('mediaType', offer)
    const parameters = Result.getOrThrow(parsed).preferences[0]?.parameters
    expect(parameters).toStrictEqual({
      ['__proto__']: 'x',
      constructor: 'y',
      profile: globalThis.String.raw`a,;\"b`,
    })
  })

  test('requires matching values for prototype-named parameters', () => {
    expect(choose('mediaType', 'text/html;__proto__=x', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;constructor=y', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;toString=z', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;__proto__=x', ['text/html;__proto__=y'])).toBeNull()
    expect(Result.isFailure(Accepts.parse('mediaType', 'text/html;__proto__=x;__proto__=y'))).toBe(true)
  })
})
