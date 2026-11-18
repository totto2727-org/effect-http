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
  Predicate,
  Ref,
  Result,
  Schema,
  SchemaTransformation,
  String,
  pipe,
} from 'effect'
import * as Cookies from 'effect/http/Cookies'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import * as CacheControl from './cacheControl.ts'
import * as HttpDate from './internal/httpDate.ts'

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

const Capacity = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand('ResponseCacheCapacity'))
const Lifetime = Schema.Finite.check(Schema.isGreaterThan(0)).pipe(Schema.brand('ResponseCacheLifetime'))
const BodyLimit = Schema.Natural.pipe(Schema.brand('ResponseCacheBodyLimit'))
const Configuration = Schema.Struct({
  capacity: Capacity,
  ttlMilliseconds: Lifetime,
  maxBodyBytes: BodyLimit,
  publicRoute: Schema.Literal(true),
})
const AgeSeconds = Schema.Natural.check(Schema.isLessThanOrEqualTo(9_007_199_254_740_991 / 1000)).pipe(
  Schema.brand('ResponseCacheAgeSeconds'),
)
const AgeFromString = Schema.String.check(Schema.isMaxLength(16), Schema.isPattern(/^\d+$(?![\s\S])/u)).pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(AgeSeconds),
)
const HeaderValue = Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^[\t\x20-\x7e]*$(?![\s\S])/u)).pipe(
  Schema.brand('ResponseCacheHeaderValue'),
)
const HeaderName = Schema.String.pipe(Schema.decode(SchemaTransformation.toLowerCase()))
  .check(Schema.isPattern(/^[!#$%&'*+.^_`|~\w-]+$(?![\s\S])/u))
  .pipe(Schema.brand('ResponseCacheHeaderName'))
const VaryNames = Schema.Array(HeaderName)
const DeclaredVary = VaryNames.check(Schema.isMaxLength(64))
type BodyLimit = typeof BodyLimit.Type
type Lifetime = typeof Lifetime.Type
type HeaderName = typeof HeaderName.Type
const decodeConfiguration = Schema.decodeUnknownOption(Configuration)
const decodeVaryNames = Schema.decodeUnknownOption(VaryNames)
const decodeHeaderValue = Schema.decodeUnknownOption(HeaderValue)
const decodeDeclaredVary = Schema.decodeUnknownOption(DeclaredVary)
const decodeAge = Schema.decodeUnknownOption(AgeFromString)
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)))

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
      (key) => Predicate.isNotNullish(headers[key]),
    )
  )
}

const storableResponse = (
  response: HttpServerResponse.HttpServerResponse,
  maxBodyBytes: BodyLimit,
  vary: ReadonlyArray<HeaderName>,
): boolean => {
  const { body, headers } = response
  if (
    response.status !== 200 ||
    !Cookies.isEmpty(response.cookies) ||
    Predicate.isNotNullish(headers['set-cookie']) ||
    Predicate.isNotNullish(headers['expires']) ||
    (body._tag !== 'Empty' && body._tag !== 'Uint8Array') ||
    (body._tag === 'Uint8Array' && body.body.length > maxBodyBytes) ||
    Option.fromNullishOr(headers['content-type']).pipe(
      Option.map(String.toLowerCase),
      Option.exists(String.startsWith('text/event-stream')),
    )
  )
    return false
  const varyHeader = headers['vary']
  if (Predicate.isNullish(varyHeader)) return true
  const validated = decodeHeaderValue(varyHeader)
  if (Option.isNone(validated)) return false
  const declared = pipe(validated.value, String.split(','), Array.map(String.trim), decodeDeclaredVary)
  return Option.exists(declared, (names) => Array.every(names, (name) => name !== '*' && Array.contains(vary, name)))
}

/** Derive freshness only after every origin policy, Age and Date value has been validated. */
const freshness = (
  headers: HttpServerResponse.HttpServerResponse['headers'],
  ttlMilliseconds: Lifetime,
  requestedAt: number,
  storedAt: number,
) =>
  Option.gen(function* () {
    const control = headers['cache-control']
    const directives = Predicate.isNullish(control) ? {} : yield* Result.getSuccess(CacheControl.parse(control))
    if (directives.private || directives.noStore || directives.noCache) return yield* Option.none()
    const seconds = directives.sMaxAge ?? directives.maxAge
    const lifetime = Predicate.isNullish(seconds) ? ttlMilliseconds : Number.min(ttlMilliseconds, seconds * 1000)
    const ageSeconds = yield* decodeAge(headers['age'] ?? '0')
    const originDate = headers['date']
    const apparentAge = Predicate.isNullish(originDate)
      ? 0
      : Number.max(0, storedAt - DateTime.toEpochMillis(yield* HttpDate.parse(originDate)))
    // Corrected initial age retains subsecond apparent age and includes the origin response delay.
    const initialAgeMilliseconds = Number.max(ageSeconds * 1000 + Number.max(0, storedAt - requestedAt), apparentAge)
    const remaining = lifetime - initialAgeMilliseconds
    return remaining <= 0 ? yield* Option.none() : { expiresAt: storedAt + remaining, initialAgeMilliseconds }
  })

/** Explicit public GET route cache, not a proxy cache. Call invalidateAll after writes, including writes outside this route. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    const config = Option.getOrThrowWith(
      decodeConfiguration(options),
      () => new ConfigError({ message: 'Invalid route cache configuration' }),
    )
    const vary = pipe(
      Option.getOrThrowWith(
        decodeVaryNames(options.vary),
        () => new ConfigError({ message: 'Invalid Vary declaration' }),
      ),
      HashSet.fromIterable,
      Array.fromIterable,
      Array.sort(String.Order),
    )
    if (Array.some(vary, (name) => Array.contains(['authorization', 'cookie'], name))) {
      throw new ConfigError({ message: 'Invalid Vary declaration' })
    }
    const storage = yield* Cache.make<string, Entry>({
      capacity: config.capacity,
      timeToLive: config.ttlMilliseconds,
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
        if (!storableResponse(response, config.maxBodyBytes, vary)) return response
        const storedAt = yield* Clock.currentTimeMillis
        const fresh = freshness(response.headers, config.ttlMilliseconds, now, storedAt)
        if (Option.isNone(fresh) || (yield* Ref.get(generation)) !== currentGeneration) return response
        const output =
          vary.length === 0 ? response : HttpServerResponse.setHeader(response, 'vary', Array.join(vary, ', '))
        yield* Cache.set(storage, key, { response: copy(output), storedAt, ...fresh.value })
        return output
      })
    return { middleware, invalidateAll }
  })
