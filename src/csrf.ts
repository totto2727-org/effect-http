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

/* oxlint-disable rules/no-readonly -- These exported interfaces preserve declaration merging and immutable inputs. */
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

/* oxlint-enable rules/no-readonly */

export type Decision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false
      reason: 'invalid-target' | 'invalid-origin' | 'untrusted-origin' | 'contradictory-metadata' | 'missing-proof'
    }>

export class ConfigError extends Data.TaggedError('ConfigError')<{
  message: string
  cause: Schema.SchemaError
}> {}

const HttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) => (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password),
).pipe(Schema.brand('CsrfHttpUrl'))
const OriginValue = HttpUrl.check(Schema.makeFilter((url) => url.pathname === '/' && !url.search && !url.hash)).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((url) => url.origin),
    encode: SchemaGetter.forbiddenEncoding,
  }),
  Schema.brand('CsrfOrigin'),
)
type Origin = typeof OriginValue.Type
const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)
const parseUrl = Schema.decodeUnknownOption(HttpUrl)
const decodeOrigin = Schema.decodeUnknownResult(OriginValue)
const parseOrigin = (value: string): Option.Option<Origin> => Result.getSuccess(decodeOrigin(value))

const origins = (config: Config): HashSet.HashSet<Origin> =>
  pipe(
    config.allowedOrigins ?? [],
    Array.map((value) =>
      Result.getOrThrowWith(
        decodeOrigin(value),
        (cause) => new ConfigError({ cause, message: `Invalid allowed origin: ${value}` }),
      ),
    ),
    HashSet.fromIterable,
  )

const evaluateProof = (
  {
    origin,
    site,
    targetOrigin,
  }: Readonly<{
    origin: Option.Option<Origin>
    site: string | undefined
    targetOrigin: string
  }>,
  allowedOrigins: HashSet.HashSet<Origin>,
): Decision => {
  const sameOrigin = Option.exists(origin, (value) => value === targetOrigin)
  if (Option.isSome(origin) && !sameOrigin && !HashSet.has(allowedOrigins, origin.value)) {
    return { allowed: false, reason: 'untrusted-origin' }
  }
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
  return evaluateProof({ origin, site: request.secFetchSite, targetOrigin: target.value.origin }, allowedOrigins)
}

/**
 * Evaluate the request proof. Throws ConfigError for invalid configuration.
 * @param {Request} request - The method, target URL, and request proof headers.
 * @param {Config} config - Additional exact origins to allow.
 * @returns {Decision} The decision, including a reason when it denies the request.
 */
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
    Array.map((name): Readonly<[string, string]> => [`:${String.toLowerCase(name)}`, name]),
    Record.fromEntries,
    Record.values,
    Array.join(', '),
  )
  return HttpServerResponse.setHeader(response, 'vary', merged)
}

/**
 * Check every unsafe method, including JSON requests, using the request target and proof headers.
 * @param {Config} config - Additional exact origins to allow.
 * @returns {HttpMiddleware.HttpMiddleware} Middleware requiring the current HTTP server request.
 */
export const middleware = (
  config: Config = {},
): (<E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest>) => {
  const allowedOrigins = origins(config)
  return HttpMiddleware.make(<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = pipe(
        decodeUrl(request.originalUrl),
        Option.match({
          onNone: () =>
            Predicate.isNullish(request.headers['host'])
              ? ''
              : pipe(
                  HttpServerRequest.toURL(request),
                  Option.map((target) => target.href),
                  Option.getOrElse(() => ''),
                ),
          onSome: () => request.originalUrl,
        }),
      )
      const decision = evaluate(
        {
          method: request.method,
          origin: request.headers['origin'],
          secFetchSite: request.headers['sec-fetch-site'],
          url,
        },
        allowedOrigins,
      )
      if (!decision.allowed) {
        return vary(HttpServerResponse.empty({ headers: { 'cache-control': 'no-store' }, status: 403 }))
      }
      return vary(yield* app)
    }),
  )
}
