import {
  Array,
  Data,
  Effect,
  HashSet,
  Option,
  Predicate,
  pipe,
  Record,
  Result,
  Schema,
  SchemaGetter,
  String,
} from 'effect'
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from 'effect/http'

export interface Config {
  /** Additional exact HTTP(S) origins. Paths, credentials, query strings, and fragments are rejected after URL normalization. */
  readonly allowedOrigins?: readonly string[]
}

export interface Request {
  readonly method: string
  /** Absolute request target URL, obtained without trusting forwarded headers. */
  readonly url: string
  readonly origin?: string | undefined
  readonly secFetchSite?: string | undefined
}

export type Decision =
  | { readonly allowed: true }
  | {
      readonly allowed: false
      readonly reason:
        | 'invalid-target'
        | 'invalid-origin'
        | 'untrusted-origin'
        | 'contradictory-metadata'
        | 'missing-proof'
    }

export class ConfigError extends Data.TaggedError('ConfigError')<{
  readonly message: string
  readonly cause: Schema.SchemaError
}> {}

const HttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password),
).pipe(Schema.brand('CsrfHttpUrl'))
const Origin = HttpUrl.check(Schema.makeFilter((url) => url.pathname === '/' && !url.search && !url.hash)).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((url) => url.origin),
    encode: SchemaGetter.forbiddenEncoding,
  }),
  Schema.brand('CsrfOrigin'),
)
type Origin = typeof Origin.Type
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)
const parseUrl = Schema.decodeUnknownOption(HttpUrl)
const decodeOrigin = Schema.decodeUnknownResult(Origin)
const parseOrigin = (value: string): Option.Option<Origin> => Result.getSuccess(decodeOrigin(value))

const origins = (config: Config): HashSet.HashSet<Origin> =>
  pipe(
    config.allowedOrigins ?? [],
    Array.map((value) =>
      Result.getOrThrowWith(
        decodeOrigin(value),
        (cause) => new ConfigError({ message: `Invalid allowed origin: ${value}`, cause }),
      ),
    ),
    HashSet.fromIterable,
  )

const evaluate = (request: Request, allowedOrigins: HashSet.HashSet<Origin>): Decision => {
  if (Array.contains(['GET', 'HEAD', 'OPTIONS'], String.toUpperCase(request.method))) {
    return { allowed: true }
  }
  const target = parseUrl(request.url)
  if (Option.isNone(target)) {
    return { allowed: false, reason: 'invalid-target' }
  }
  const origin = Predicate.isNullish(request.origin) ? Option.none<Origin>() : parseOrigin(request.origin)
  if (Predicate.isNotNullish(request.origin) && Option.isNone(origin)) {
    return { allowed: false, reason: 'invalid-origin' }
  }
  const sameOrigin = Option.exists(origin, (value) => value === target.value.origin)
  if (Option.isSome(origin) && !sameOrigin && !HashSet.has(allowedOrigins, origin.value)) {
    return { allowed: false, reason: 'untrusted-origin' }
  }
  const site = request.secFetchSite
  if (
    Predicate.isNotNullish(site) &&
    (!Array.contains(['same-origin', 'same-site', 'cross-site'], site) ||
      (site === 'same-origin' && Option.isSome(origin) && !sameOrigin) ||
      (site === 'cross-site' && sameOrigin))
  ) {
    return { allowed: false, reason: 'contradictory-metadata' }
  }
  return Option.isSome(origin) || site === 'same-origin'
    ? { allowed: true }
    : { allowed: false, reason: 'missing-proof' }
}

/** Pure CSRF decision. Invalid configuration throws ConfigError, invalid request proof is denied. */
export const decide = (request: Request, config: Config = {}): Decision => evaluate(request, origins(config))

const vary = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse => {
  const existing = pipe(response.headers['vary'] ?? '', String.split(','), Array.map(String.trim))
  if (Array.contains(existing, '*')) {
    return response
  }
  const merged = pipe(
    existing,
    Array.filter(String.isNonEmpty),
    Array.appendAll(['Origin', 'Sec-Fetch-Site']),
    // Prefix keys so numeric field names also retain insertion order.
    Array.map((name): readonly [string, string] => [`:${String.toLowerCase(name)}`, name]),
    Record.fromEntries,
    Record.values,
    Array.join(', '),
  )
  return HttpServerResponse.setHeader(response, 'vary', merged)
}

/** Checks every unsafe method, including JSON requests. Does not inspect forwarded headers. */
export const middleware = (config: Config = {}) => {
  const allowedOrigins = origins(config)
  return HttpMiddleware.make(<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = pipe(
        decodeUrl(request.originalUrl),
        Option.match({
          onSome: () => request.originalUrl,
          onNone: () =>
            Predicate.isNullish(request.headers['host'])
              ? ''
              : pipe(
                  HttpServerRequest.toURL(request),
                  Option.map((url) => url.href),
                  Option.getOrElse(() => ''),
                ),
        }),
      )
      const decision = evaluate(
        {
          method: request.method,
          url,
          origin: request.headers['origin'],
          secFetchSite: request.headers['sec-fetch-site'],
        },
        allowedOrigins,
      )
      if (!decision.allowed) {
        return vary(HttpServerResponse.empty({ status: 403, headers: { 'cache-control': 'no-store' } }))
      }
      return vary(yield* app)
    }),
  )
}
