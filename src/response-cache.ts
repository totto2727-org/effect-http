import {
  Array,
  BigDecimal,
  Bytes,
  Cache,
  Clock,
  Data,
  Effect,
  HashSet,
  Number,
  Option,
  Predicate,
  Ref,
  Schema,
  SchemaTransformation,
  String,
  pipe,
} from 'effect'
import { Cookies, HttpServerRequest, HttpServerResponse } from 'effect/http'

import type { Freshness } from './cache-freshness.ts'
import { deriveFreshness, millisecondsPerSecond } from './cache-freshness.ts'

/* oxlint-disable rules/no-readonly -- The exported interface preserves declaration merging and immutable cache configuration. */
export interface Options {
  readonly capacity: number
  readonly ttlMilliseconds: number
  readonly maxBodyBytes: number
  readonly vary: readonly string[]
  /** Caller guarantees output depends only on target, host and declared variants, never other headers or identity. */
  readonly publicRoute: true
}
/* oxlint-enable rules/no-readonly */

type Entry = Freshness &
  Readonly<{
    response: HttpServerResponse.HttpServerResponse
    storedAt: number
  }>

export class ConfigError extends Data.TaggedError('ResponseCacheConfigError')<{
  message: string
}> {}

const emptyAgeMilliseconds = 0
const exclusiveMinimumCapacity = 0
const exclusiveMinimumLifetimeMilliseconds = 0
const maximumHeaderLength = 8192
const maximumVaryNames = 64
const okStatus = 200

const Capacity = Schema.Int.check(Schema.isGreaterThan(exclusiveMinimumCapacity)).pipe(
  Schema.brand('ResponseCacheCapacity'),
)
const LifetimeValue = Schema.Finite.check(Schema.isGreaterThan(exclusiveMinimumLifetimeMilliseconds)).pipe(
  Schema.brand('ResponseCacheLifetime'),
)
const BodyLimitValue = Schema.Natural.pipe(Schema.brand('ResponseCacheBodyLimit'))
const Configuration = Schema.Struct({
  capacity: Capacity,
  maxBodyBytes: BodyLimitValue,
  publicRoute: Schema.Literal(true),
  ttlMilliseconds: LifetimeValue,
})
const HeaderValue = Schema.String.check(
  Schema.isMaxLength(maximumHeaderLength),
  Schema.isPattern(/^[\t\u0020-\u007E]*$(?![\s\S])/u),
).pipe(Schema.brand('ResponseCacheHeaderValue'))
const HeaderNameValue = Schema.String.pipe(Schema.decode(SchemaTransformation.toLowerCase()))
  .check(Schema.isPattern(/^[!#$%&'*+.^_`|~\w-]+$(?![\s\S])/u))
  .pipe(Schema.brand('ResponseCacheHeaderName'))
const VaryNames = Schema.Array(HeaderNameValue)
const DeclaredVary = VaryNames.check(Schema.isMaxLength(maximumVaryNames))
type BodyLimit = typeof BodyLimitValue.Type
type Lifetime = typeof LifetimeValue.Type
type HeaderName = typeof HeaderNameValue.Type
const decodeConfiguration = Schema.decodeUnknownOption(Configuration)
const decodeVaryNames = Schema.decodeUnknownOption(VaryNames)
const decodeHeaderValue = Schema.decodeUnknownOption(HeaderValue)
const decodeDeclaredVary = Schema.decodeUnknownOption(DeclaredVary)
// oxlint-disable-next-line node/no-sync -- Schema encodes an in-memory key and performs no blocking Node I/O.
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Json)))

const copy = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse =>
  Predicate.isTagged(response.body, 'Uint8Array')
    ? HttpServerResponse.uint8Array(Bytes.concat([response.body.body]), {
        headers: response.headers,
        status: response.status,
      })
    : HttpServerResponse.empty({ headers: response.headers, status: response.status })

const blockedRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const { headers } = request
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
  vary: Readonly<HeaderName[]>,
): boolean => {
  const { body, headers } = response
  if (
    response.status !== okStatus ||
    !Cookies.isEmpty(response.cookies) ||
    Predicate.isNotNullish(headers['set-cookie']) ||
    Predicate.isNotNullish(headers['expires']) ||
    (!Predicate.isTagged(body, 'Empty') && !Predicate.isTagged(body, 'Uint8Array')) ||
    (Predicate.isTagged(body, 'Uint8Array') && body.body.length > maxBodyBytes) ||
    Option.fromNullishOr(headers['content-type']).pipe(
      Option.map(String.toLowerCase),
      Option.exists(String.startsWith('text/event-stream')),
    )
  ) {
    return false
  }
  const varyHeader = headers['vary']
  if (Predicate.isNullish(varyHeader)) {
    return true
  }
  const validated = decodeHeaderValue(varyHeader)
  if (Option.isNone(validated)) {
    return false
  }
  return pipe(
    validated.value,
    String.split(','),
    Array.map(String.trim),
    decodeDeclaredVary,
    Option.exists((names) => Array.every(names, (name) => name !== '*' && Array.contains(vary, name))),
  )
}

type CachePolicy = Readonly<{
  capacity: typeof Capacity.Type
  maxBodyBytes: BodyLimit
  ttlMilliseconds: Lifetime
  vary: Readonly<HeaderName[]>
}>
type CacheState = Readonly<{
  generation: Ref.Ref<number>
  storage: Cache.Cache<string, Entry>
}>
type CacheLookup = Readonly<{
  generation: number
  key: string
  requestedAt: number
}>
interface RouteCache {
  invalidateAll: Effect.Effect<void>
  middleware: <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>
}

const decodePolicy = (options: Options): CachePolicy => {
  const config = Option.getOrThrowWith(
    decodeConfiguration(options),
    () => new ConfigError({ message: 'Invalid route cache configuration' }),
  )
  const names = Option.getOrThrowWith(
    decodeVaryNames(options.vary),
    () => new ConfigError({ message: 'Invalid Vary declaration' }),
  )
  const uniqueNames = Array.fromIterable(HashSet.fromIterable(names))
  const vary = Array.sort(uniqueNames, String.Order)
  if (Array.some(vary, (name) => Array.contains(['authorization', 'cookie'], name))) {
    throw new ConfigError({ message: 'Invalid Vary declaration' })
  }
  return { ...config, vary }
}

const prepareLookup = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  state: CacheState,
  policy: CachePolicy,
) {
  if (blockedRequest(request)) {
    return Option.none<CacheLookup>()
  }
  const url = HttpServerRequest.toURL(request)
  if (Option.isNone(url)) {
    return Option.none<CacheLookup>()
  }
  const generation = yield* Ref.get(state.generation)
  const key = encodeKey([
    generation,
    request.method,
    request.originalUrl,
    url.value.href,
    request.headers['host'] ?? '',
    // oxlint-disable-next-line unicorn/no-null -- The JSON key distinguishes an absent header from an empty field.
    Array.map(policy.vary, (name) => [name, request.headers[name] ?? null]),
  ])
  const requestedAt = yield* Clock.currentTimeMillis
  return Option.some({ generation, key, requestedAt })
})

const readHit = Effect.fnUntraced(function* (state: CacheState, lookup: CacheLookup) {
  const cached = yield* Cache.getOption(state.storage, lookup.key)
  if (
    Option.isNone(cached) ||
    (yield* Ref.get(state.generation)) !== lookup.generation ||
    !Number.isLessThan(lookup.requestedAt, cached.value.expiresAt)
  ) {
    return Option.none<HttpServerResponse.HttpServerResponse>()
  }
  const residence = Number.max(emptyAgeMilliseconds, lookup.requestedAt - cached.value.storedAt)
  const age = residence + cached.value.initialAgeMilliseconds
  const ageSeconds = pipe(
    age / millisecondsPerSecond,
    BigDecimal.fromNumberUnsafe,
    BigDecimal.floor,
    BigDecimal.toNumberUnsafe,
  )
  return Option.some(HttpServerResponse.setHeader(copy(cached.value.response), 'age', `${ageSeconds}`))
})

const storeFresh = Effect.fnUntraced(function* (
  response: HttpServerResponse.HttpServerResponse,
  policy: CachePolicy,
  { lookup, state }: Readonly<{ lookup: CacheLookup; state: CacheState }>,
) {
  if (!storableResponse(response, policy.maxBodyBytes, policy.vary)) {
    return response
  }
  const storedAt = yield* Clock.currentTimeMillis
  const fresh = deriveFreshness(response.headers, policy.ttlMilliseconds, { requestedAt: lookup.requestedAt, storedAt })
  if (Option.isNone(fresh) || (yield* Ref.get(state.generation)) !== lookup.generation) {
    return response
  }
  const output = Array.isReadonlyArrayEmpty(policy.vary)
    ? response
    : HttpServerResponse.setHeader(response, 'vary', Array.join(policy.vary, ', '))
  yield* Cache.set(state.storage, lookup.key, { response: copy(output), storedAt, ...fresh.value })
  return output
})

/**
 * Create a public GET route cache with explicit invalidation after writes.
 * @param {Options} options - Route eligibility, capacity, retention, and variant fields.
 * @returns {Effect.Effect<RouteCache>} An Effect allocating the middleware and its invalidation operation.
 */
export const make = (options: Options): Effect.Effect<RouteCache> =>
  Effect.gen(function* () {
    const policy = decodePolicy(options)
    const storage = yield* Cache.make<string, Entry>({
      capacity: policy.capacity,
      lookup: () => Effect.die(new ConfigError({ message: 'Route cache uses explicit insertion only' })),
      timeToLive: policy.ttlMilliseconds,
    })
    const initialGeneration = 0
    const generation = yield* Ref.make(initialGeneration)
    const state = { generation, storage }
    const invalidateAll = Effect.uninterruptible(
      Effect.andThen(Ref.update(generation, Number.increment), Cache.invalidateAll(storage)),
    )
    const middleware: RouteCache['middleware'] = (handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const lookup = yield* prepareLookup(request, state, policy)
        if (Option.isNone(lookup)) {
          return yield* handler
        }
        const cached = yield* readHit(state, lookup.value)
        return Option.isSome(cached)
          ? cached.value
          : yield* storeFresh(yield* handler, policy, { lookup: lookup.value, state })
      })
    return { invalidateAll, middleware }
  })
