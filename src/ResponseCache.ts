import {
  Array,
  BigDecimal,
  Bytes,
  Cache,
  Clock,
  Data,
  DateTime,
  Effect,
  HashSet,
  Number,
  Option,
  Ref,
  Result,
  Schema,
  String,
  pipe,
} from 'effect'
import * as Cookies from 'effect/http/Cookies'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import * as CacheControl from './CacheControl.ts'
import * as HttpDate from './internal/HttpDate.ts'

export interface Options {
  readonly capacity: number
  readonly ttlMilliseconds: number
  readonly maxBodyBytes: number
  readonly vary: ReadonlyArray<string>
  /** Caller guarantees output depends only on target, host and declared variants, never other headers or identity. */
  readonly publicRoute: true
}
interface Entry {
  readonly response: HttpServerResponse.HttpServerResponse
  readonly storedAt: number
  readonly expiresAt: number
  readonly initialAgeMilliseconds: number
}

export class ConfigError extends Data.TaggedError('ResponseCacheConfigError')<{
  readonly message: string
}> {}

const isNatural = Schema.is(Schema.Natural)
const isPositiveInteger = Schema.is(Schema.Int.check(Schema.isGreaterThan(0)))
const isPositiveLifetime = Schema.is(Schema.Finite.check(Schema.isGreaterThan(0)))
const isAgeSeconds = Schema.is(Schema.Natural.check(Schema.isLessThanOrEqualTo(9_007_199_254_740_991 / 1000)))
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)))
const invalidHeaderBytes = String.match(/[^\t\x20-\x7e]/)
const varyToken = String.match(/^[!#$%&'*+.^_`|~\w-]+$/)

const copy = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse =>
  response.body._tag === 'Uint8Array'
    ? HttpServerResponse.uint8Array(Bytes.concat([response.body.body]), {
        status: response.status,
        headers: response.headers,
      })
    : HttpServerResponse.empty({ status: response.status, headers: response.headers })

const blockedRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const headers = request.headers
  // All supported request cache directives require revalidation, which this route cache does not implement.
  return (
    request.method !== 'GET' ||
    Array.some(
      [
        'authorization',
        'cookie',
        'range',
        'if-range',
        'if-match',
        'if-none-match',
        'if-modified-since',
        'if-unmodified-since',
        'pragma',
        'cache-control',
      ],
      (key) => headers[key] !== undefined,
    )
  )
}

const storableResponse = (
  response: HttpServerResponse.HttpServerResponse,
  maxBodyBytes: number,
  vary: ReadonlyArray<string>,
): boolean => {
  const { body, headers } = response
  if (
    response.status !== 200 ||
    !Cookies.isEmpty(response.cookies) ||
    headers['set-cookie'] !== undefined ||
    headers['expires'] !== undefined ||
    (body._tag !== 'Empty' && body._tag !== 'Uint8Array') ||
    (body._tag === 'Uint8Array' && body.body.length > maxBodyBytes) ||
    Option.fromNullishOr(headers['content-type']).pipe(
      Option.map(String.toLowerCase),
      Option.exists(String.startsWith('text/event-stream')),
    )
  )
    return false
  const varyHeader = headers['vary']
  if (varyHeader === undefined) return true
  if (String.length(varyHeader) > 8192 || Option.isSome(invalidHeaderBytes(varyHeader))) return false
  const declared = pipe(
    varyHeader,
    String.split(','),
    Array.map((value) => String.toLowerCase(String.trim(value))),
  )
  return declared.length <= 64 && Array.every(declared, (name) => name !== '*' && Array.contains(vary, name))
}

/** Derive freshness only after every origin policy, Age and Date value has been validated. */
const freshness = (
  headers: HttpServerResponse.HttpServerResponse['headers'],
  ttlMilliseconds: number,
  requestedAt: number,
  storedAt: number,
) =>
  Option.gen(function* () {
    const control = headers['cache-control']
    const directives = control === undefined ? {} : yield* Result.getSuccess(CacheControl.parse(control))
    if (directives.private || directives.noStore || directives.noCache) return yield* Option.none()
    const seconds = directives.sMaxAge ?? directives.maxAge
    const lifetime = seconds === undefined ? ttlMilliseconds : Number.min(ttlMilliseconds, seconds * 1000)
    const age = headers['age']
    if (age !== undefined && (String.length(age) > 16 || Option.isNone(String.match(/^\d+$/)(age)))) {
      return yield* Option.none()
    }
    const ageSeconds = age === undefined ? 0 : yield* Number.parse(age).pipe(Option.filter(isAgeSeconds))
    const originDate = headers['date']
    const apparentAge =
      originDate === undefined ? 0 : Number.max(0, storedAt - DateTime.toEpochMillis(yield* HttpDate.parse(originDate)))
    // Corrected initial age retains subsecond apparent age and includes the origin response delay.
    const initialAgeMilliseconds = Number.max(ageSeconds * 1000 + Number.max(0, storedAt - requestedAt), apparentAge)
    const remaining = lifetime - initialAgeMilliseconds
    return remaining <= 0 ? yield* Option.none() : { expiresAt: storedAt + remaining, initialAgeMilliseconds }
  })

/** Explicit public GET route cache, not a proxy cache. Call invalidateAll after writes, including writes outside this route. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    if (
      options.publicRoute !== true ||
      !isPositiveInteger(options.capacity) ||
      !isNatural(options.maxBodyBytes) ||
      !isPositiveLifetime(options.ttlMilliseconds)
    )
      throw new ConfigError({ message: 'Invalid route cache configuration' })
    const vary = pipe(
      options.vary,
      Array.map(String.toLowerCase),
      HashSet.fromIterable,
      Array.fromIterable,
      Array.sort(String.Order),
    )
    if (
      Array.some(vary, (name) => Option.isNone(varyToken(name)) || Array.contains(['authorization', 'cookie'], name))
    ) {
      throw new ConfigError({ message: 'Invalid Vary declaration' })
    }
    const storage = yield* Cache.make<string, Entry>({
      capacity: options.capacity,
      timeToLive: options.ttlMilliseconds,
      lookup: () => Effect.die(new ConfigError({ message: 'Route cache uses explicit insertion only' })),
    })
    const generation = yield* Ref.make(0)
    const invalidateAll = Effect.uninterruptible(
      Effect.andThen(Ref.update(generation, Number.increment), Cache.invalidateAll(storage)),
    )
    const middleware = <E, R>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (blockedRequest(request)) return yield* handler
        const url = HttpServerRequest.toURL(request)
        if (Option.isNone(url)) return yield* handler
        const currentGeneration = yield* Ref.get(generation)
        const key = encodeKey([
          currentGeneration,
          request.method,
          request.originalUrl,
          url.value.href,
          request.headers['host'] ?? '',
          Array.map(vary, (name) => [name, request.headers[name] ?? null]),
        ])
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Cache.getOption(storage, key)
        if (
          Option.isSome(cached) &&
          (yield* Ref.get(generation)) === currentGeneration &&
          now < cached.value.expiresAt
        ) {
          const age = Number.max(0, now - cached.value.storedAt) + cached.value.initialAgeMilliseconds
          const ageSeconds = pipe(age / 1000, BigDecimal.fromNumberUnsafe, BigDecimal.floor, BigDecimal.toNumberUnsafe)
          return HttpServerResponse.setHeader(copy(cached.value.response), 'age', `${ageSeconds}`)
        }
        const response = yield* handler
        if (!storableResponse(response, options.maxBodyBytes, vary)) return response
        const storedAt = yield* Clock.currentTimeMillis
        const fresh = freshness(response.headers, options.ttlMilliseconds, now, storedAt)
        if (Option.isNone(fresh) || (yield* Ref.get(generation)) !== currentGeneration) return response
        const output =
          vary.length === 0 ? response : HttpServerResponse.setHeader(response, 'vary', Array.join(vary, ', '))
        yield* Cache.set(storage, key, { response: copy(output), storedAt, ...fresh.value })
        return output
      })
    return { middleware, invalidateAll }
  })
