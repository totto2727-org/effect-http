import { DateTime, Number, Option, Predicate, Result, Schema } from 'effect'
import type { HttpServerResponse } from 'effect/http'

import * as CacheControl from './cache-control.ts'
import * as HttpDate from './internal/http-date.ts'

const emptyAgeMilliseconds = 0
export const millisecondsPerSecond = 1000
const maximumAgeDigits = 16

export type Freshness = Readonly<{
  expiresAt: number
  initialAgeMilliseconds: number
}>

const AgeSeconds = Schema.Natural.check(
  Schema.isLessThanOrEqualTo(globalThis.Number.MAX_SAFE_INTEGER / millisecondsPerSecond),
).pipe(Schema.brand('ResponseCacheAgeSeconds'))
const AgeFromString = Schema.String.check(
  Schema.isMaxLength(maximumAgeDigits),
  Schema.isPattern(/^\d+$(?![\s\S])/u),
).pipe(Schema.decodeTo(Schema.NumberFromString), Schema.decodeTo(AgeSeconds))
const decodeAge = Schema.decodeUnknownOption(AgeFromString)

const freshnessLifetime = (control: string | undefined, ttlMilliseconds: number): Option.Option<number> =>
  Option.gen(function* () {
    const directives = Predicate.isNullish(control) ? {} : yield* Result.getSuccess(CacheControl.parse(control))
    if (directives.private === true || directives.noStore === true || directives.noCache === true) {
      return yield* Option.none()
    }
    const seconds = directives.sMaxAge ?? directives.maxAge
    return Predicate.isNullish(seconds) ? ttlMilliseconds : Number.min(ttlMilliseconds, seconds * millisecondsPerSecond)
  })

// Derive freshness after validating the origin policy, Age, and Date.
export const deriveFreshness = (
  headers: HttpServerResponse.HttpServerResponse['headers'],
  ttlMilliseconds: number,
  { requestedAt, storedAt }: Readonly<{ requestedAt: number; storedAt: number }>,
): Option.Option<Freshness> =>
  Option.gen(function* () {
    const lifetime = yield* freshnessLifetime(headers['cache-control'], ttlMilliseconds)
    const ageSeconds = yield* decodeAge(headers['age'] ?? '0')
    const originDate = headers['date']
    const apparentAge = Predicate.isNullish(originDate)
      ? emptyAgeMilliseconds
      : Number.max(emptyAgeMilliseconds, storedAt - DateTime.toEpochMillis(yield* HttpDate.parse(originDate)))
    // Corrected initial age retains subsecond apparent age and includes the origin response delay.
    const responseDelay = Number.max(emptyAgeMilliseconds, storedAt - requestedAt)
    const initialAgeMilliseconds = Number.max(ageSeconds * millisecondsPerSecond + responseDelay, apparentAge)
    const remaining = lifetime - initialAgeMilliseconds
    return remaining <= emptyAgeMilliseconds
      ? yield* Option.none()
      : { expiresAt: storedAt + remaining, initialAgeMilliseconds }
  })
