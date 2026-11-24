import { Array as Arr, Effect, Option, Result, String as Str } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

import * as Accepts from './accepts.ts'

const choose = (kind: Accepts.Kind, header: string | null | undefined, supports: ReadonlyArray<string>) => {
  const result = Accepts.negotiate(kind, header, supports)
  if (Result.isFailure(result)) throw new Error(result.failure.reason)
  return Option.getOrNull(result.success)
}

describe('Accepts media negotiation', () => {
  test('uses specificity to determine effective quality before ranking offers', () => {
    expect(
      choose('mediaType', 'text/*;q=1,text/html;q=0.1,application/json;q=0.5', ['text/html', 'application/json']),
    ).toBe('application/json')
    expect(choose('mediaType', '*/*;q=1,text/*;q=0.2,text/html;q=0', ['text/html'])).toBeNull()
    expect(choose('mediaType', '*/*;q=1,text/*;q=0', ['text/plain'])).toBeNull()
  })

  test('accepts exactly the maximum header, offer, list and parameter sizes', () => {
    const longestCoding = Str.repeat(8192)('x')
    expect(choose('encoding', longestCoding, [longestCoding])).toBe(longestCoding)
    expect(choose('encoding', Arr.join(Arr.replicate('gzip', 128), ','), Arr.replicate('gzip', 128))).toBe('gzip')

    const media = `text/html${Arr.join(
      Arr.makeBy(128, (index) => `;p${index}=x`),
      '',
    )}`
    expect(choose('mediaType', media, [media])).toBe(media)
  })

  test.each(['gzip\n', 'gzip\r', 'gzip\0', 'gzipé'])(
    'rejects non-ASCII or forbidden control input %j at the boundary',
    (wire) => {
      const header = Accepts.parse('encoding', wire)
      const offer = Accepts.negotiate('encoding', null, [wire])
      expect(Result.isFailure(header) && header.failure.reason).toBe('Invalid or oversized header')
      expect(Result.isFailure(offer) && offer.failure.reason).toBe('Invalid or oversized offer')
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

describe('Accepts language, charset and encoding policies', () => {
  test('uses language basic filtering, with specific exclusions', () => {
    expect(choose('language', 'EN;q=0.7,fr;q=0.8', ['en-US', 'FR-ca'])).toBe('FR-ca')
    expect(choose('language', 'en-US', ['en'])).toBeNull()
    expect(choose('language', '*;q=1,en;q=0', ['en-US'])).toBeNull()
    expect(choose('language', 'en;q=1,en-US;q=0', ['en-US', 'en-GB'])).toBe('en-GB')
  })

  test('does not infer charset fallbacks', () => {
    expect(choose('charset', 'UTF-8;q=0,*;q=1', ['utf-8', 'ISO-8859-1'])).toBe('ISO-8859-1')
    expect(choose('charset', 'utf-8;q=0', ['utf-8'])).toBeNull()
  })

  test('keeps encoding identity separate from positive wildcards', () => {
    expect(choose('encoding', 'gzip;q=0.5', ['gzip', 'identity'])).toBe('identity')
    expect(choose('encoding', '*;q=0.5', ['gzip', 'identity'])).toBe('identity')
    expect(choose('encoding', '*;q=0', ['gzip', 'identity'])).toBeNull()
    expect(choose('encoding', 'identity;q=0.5,*;q=0', ['gzip', 'identity'])).toBe('identity')
    expect(choose('encoding', 'identity;q=0,*;q=1', ['identity'])).toBeNull()
    expect(choose('encoding', 'gzip;q=0,*;q=1', ['gzip', 'br'])).toBe('br')
    expect(choose('encoding', 'gzip', ['br'])).toBeNull()
  })

  test('distinguishes missing from explicitly empty headers', () => {
    for (const kind of ['mediaType', 'language', 'charset', 'encoding'] satisfies Accepts.Kind[]) {
      const supports = kind === 'mediaType' ? ['text/html'] : ['en']
      expect(choose(kind, null, supports)).toBe(supports[0])
      expect(choose(kind, undefined, supports)).toBe(supports[0])
      expect(Accepts.parse(kind, undefined)).toEqual(Accepts.parse(kind, null))
      expect(choose(kind, '', supports)).toBeNull()
      expect(choose(kind, ' \t ', supports)).toBeNull()
    }
    expect(choose('encoding', '', ['gzip', 'identity'])).toBe('identity')
    expect(Accepts.parse('mediaType', null)).toEqual(
      Result.succeed({ kind: 'mediaType', missing: true, preferences: [] }),
    )
    expect(Accepts.parse('mediaType', '')).toEqual(
      Result.succeed({ kind: 'mediaType', missing: false, preferences: [] }),
    )
  })
})

describe('Accepts strict parsing', () => {
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
    'text/html;profile="a\\"',
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

  test('validates non-media syntax and offers instead of silently skipping invalid values', () => {
    expect(Result.isFailure(Accepts.parse('language', 'en_US'))).toBe(true)
    expect(Result.isFailure(Accepts.parse('language', 'en;level=1'))).toBe(true)
    expect(Result.isFailure(Accepts.parse('encoding', 'gzip;level=1'))).toBe(true)
    expect(Result.isFailure(Accepts.parse('charset', 'utf-8;foo=bar'))).toBe(true)
    for (const offer of ['*/*', 'text/html;q=1', 'text/html,application/json', 'text/html\n']) {
      expect(Result.isFailure(Accepts.negotiate('mediaType', '*/*', ['text/html', offer]))).toBe(true)
    }
    expect(Result.isFailure(Accepts.negotiate('language', '*', ['*']))).toBe(true)
  })

  test('enforces bounds without turning oversized input into a match', () => {
    expect(Result.isFailure(Accepts.parse('mediaType', 'x'.repeat(8193)))).toBe(true)
    expect(Result.isFailure(Accepts.parse('encoding', Array.from({ length: 129 }, () => 'gzip').join(',')))).toBe(true)
    expect(
      Result.isFailure(
        Accepts.negotiate(
          'encoding',
          '*',
          Array.from({ length: 129 }, () => 'gzip'),
        ),
      ),
    ).toBe(true)
    expect(Result.isFailure(Accepts.negotiate('encoding', '*', ['x'.repeat(8193)]))).toBe(true)
    expect(
      Result.isFailure(
        Accepts.parse('mediaType', `text/html${Array.from({ length: 129 }, (_, i) => `;p${i}=x`).join('')}`),
      ),
    ).toBe(true)
  })

  test('returns parsed parameters and numeric qualities', () => {
    expect(Accepts.parse('mediaType', 'TEXT/HTML;Charset="UTF-8";q=0.125')).toEqual(
      Result.succeed({
        kind: 'mediaType',
        missing: false,
        preferences: [{ value: 'text/html', parameters: { charset: 'utf-8' }, quality: 0.125 }],
      }),
    )
  })

  test.each([
    ['text/html;q=2', Arr.replicate('text/html', 129), 'Invalid quality'],
    ['text/html;q=2,text/html;p="unterminated', [], 'Invalid or excessive preference list'],
    ['text/html;q=2,text/html;bad', [], 'Invalid quality'],
    ['text/html;bad;q=2', [], 'Invalid parameter'],
    ['text/html;q=1;p="a"b"c"', [], 'Unsupported or duplicate parameter'],
    ['text/html', ['text/html', 'text/html;q=1', '\n'], 'Invalid quality'],
    ['text/html', ['text/html', '\n', 'text/html;q=1'], 'Invalid or oversized offer'],
  ] satisfies [string, ReadonlyArray<string>, string][])(
    'keeps the first failure for %s and %j',
    (header, offers, reason) => {
      const result = Accepts.negotiate('mediaType', header, offers)
      expect(Result.isFailure(result) && result.failure).toMatchObject({
        _tag: 'AcceptsParseError',
        kind: 'mediaType',
        reason,
      })
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(Accepts.ParseError)
    },
  )

  test('keeps escaped quoted data and accepts prototype-named parameters as ordinary keys', () => {
    const offer = String.raw`TEXT/HTML;profile="a,;\\\"b";__proto__=x;constructor=y`
    expect(choose('mediaType', `${offer};q=1.`, ['text/html', offer])).toBe(offer)
    const parsed = Accepts.parse('mediaType', offer)
    const parameters = Result.isSuccess(parsed) && parsed.success.preferences[0]?.parameters
    expect(parameters).toEqual({
      profile: 'a,;\\"b',
      ['__proto__']: 'x',
      constructor: 'y',
    })
    expect(choose('mediaType', 'text/html;__proto__=x', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;constructor=y', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;toString=z', ['text/html'])).toBeNull()
    expect(choose('mediaType', 'text/html;__proto__=x', ['text/html;__proto__=y'])).toBeNull()
    expect(Result.isFailure(Accepts.parse('mediaType', 'text/html;__proto__=x;__proto__=y'))).toBe(true)
  })
})

describe('Accepts request adapters', () => {
  test.each([
    ['text/html;q=0,application/json', 200, 'application/json'],
    ['text/*;q=0,application/json;q=0,*/*', 406, 'Not acceptable'],
    ['application/json;q=invalid', 400, 'Invalid preferences'],
  ] satisfies [string, number, string][])('supports an actual Web handler for %s', async (header, status, body) => {
    const handler = HttpEffect.toWebHandler(
      Accepts.negotiateEffect('mediaType', ['text/html', 'application/json']).pipe(
        Effect.match({
          onFailure: () => HttpServerResponse.text('Invalid preferences', { status: 400 }),
          onSuccess: (selected) =>
            Option.match(selected, {
              onNone: () => HttpServerResponse.text('Not acceptable', { status: 406 }),
              onSome: (value) => HttpServerResponse.text(value),
            }),
        }),
      ),
    )
    const response = await handler(new Request('https://example.com/', { headers: { Accept: header } }))
    expect(response.status).toBe(status)
    expect(await response.text()).toBe(body)
  })

  test('reads Web Headers and Request without consuming the body', async () => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Accept-Language': 'fr' },
      body: 'untouched',
    })
    expect(Accepts.negotiateHeaders('language', request.headers, ['en', 'fr'])).toEqual(
      Result.succeed(Option.some('fr')),
    )
    expect(Accepts.negotiateRequest('mediaType', request, ['text/html', 'application/json'])).toEqual(
      Result.succeed(Option.some('application/json')),
    )
    expect(await request.text()).toBe('untouched')
  })

  test('negotiates through the real Effect request service', async () => {
    const request = HttpServerRequest.fromWeb(
      new Request('https://example.com/', {
        headers: { Accept: 'text/*;q=1,text/html;q=0.1,application/json;q=0.5' },
      }),
    )
    const selected = await Effect.runPromise(
      Accepts.negotiateEffect('mediaType', ['text/html', 'application/json']).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      ),
    )
    expect(selected).toEqual(Option.some('application/json'))
  })

  test('preserves parse failures and no-match through the Effect adapter', async () => {
    for (const [header, failure] of [
      ['text/html;q=oops', true],
      ['text/html;q=0,*/*;q=1', false],
    ] satisfies [string, boolean][]) {
      const request = HttpServerRequest.fromWeb(new Request('https://example.com/', { headers: { Accept: header } }))
      const result = await Effect.runPromise(
        Accepts.negotiateEffect('mediaType', ['text/html']).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.result,
        ),
      )
      expect(Result.isFailure(result)).toBe(failure)
      if (Result.isSuccess(result)) expect(result.success).toEqual(Option.none())
    }
  })
})
