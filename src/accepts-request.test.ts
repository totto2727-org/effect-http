import { live } from '@effect/vitest'
import { Effect, Option, Result } from 'effect'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { describe, expect, test } from 'vite-plus/test'

import * as Accepts from './accepts.ts'

describe('accepts request adapters', () => {
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
    await expect(response.text()).resolves.toBe(body)
  })

  test('reads Web Headers and Request without consuming the body', async () => {
    const request = new Request('https://example.com/', {
      body: 'untouched',
      headers: { Accept: 'application/json', 'Accept-Language': 'fr' },
      method: 'POST',
    })
    expect(Accepts.negotiateHeaders('language', request.headers, ['en', 'fr'])).toStrictEqual(
      Result.succeed(Option.some('fr')),
    )
    expect(Accepts.negotiateRequest('mediaType', request, ['text/html', 'application/json'])).toStrictEqual(
      Result.succeed(Option.some('application/json')),
    )
    await expect(request.text()).resolves.toBe('untouched')
  })
})

describe('accepts Effect request adapters', () => {
  live('negotiates through the real Effect request service', () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request('https://example.com/', {
          headers: { Accept: 'text/*;q=1,text/html;q=0.1,application/json;q=0.5' },
        }),
      )
      const selected = yield* Accepts.negotiateEffect('mediaType', ['text/html', 'application/json']).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      )
      expect(selected).toStrictEqual(Option.some('application/json'))
    }),
  )

  live.each([
    { expected: Option.none(), expectedFailure: true, header: 'text/html;q=oops' },
    { expected: Option.some(Option.none()), expectedFailure: false, header: 'text/html;q=0,*/*;q=1' },
  ])('preserves the parse outcome through the Effect adapter: $header', ({ expected, header, expectedFailure }) =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(new Request('https://example.com/', { headers: { Accept: header } }))
      const result = yield* Accepts.negotiateEffect('mediaType', ['text/html']).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.result,
      )
      expect(Result.isFailure(result)).toBe(expectedFailure)
      expect(Result.getSuccess(result)).toStrictEqual(expected)
    }),
  )
})
