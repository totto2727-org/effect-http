import { Array, Data, Effect, HashSet, Option, Predicate, pipe, Record, Result, String } from 'effect'
import { HttpMiddleware, HttpServerRequest, HttpServerResponse, Url } from 'effect/http'

export interface Config {
  /** Additional exact HTTP(S) origins. Paths, credentials, query strings, and fragments are rejected. */
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
  readonly message?: string
  readonly cause?: unknown
}> {
  constructor(message?: string, options?: ErrorOptions) {
    super(Predicate.isNullish(message) ? (options ?? {}) : { ...options, message })
  }
}

// eslint-disable-next-line no-control-regex -- Reject ASCII controls before URL normalization can strip them.
const forbiddenUrlCharacters = String.match(/[\u0000-\u0020\u007f\\]/u)
const absoluteHttpUrl = String.match(/^https?:\/\//iu)
const originSyntax = String.match(/^https?:\/\/[^/@]+\/?$/iu)

const parseUrl = (value: string): Option.Option<URL> =>
  Option.isSome(forbiddenUrlCharacters(value))
    ? Option.none()
    : pipe(
        Url.fromString(value),
        Result.getSuccess,
        Option.filter(
          (url) => (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password,
        ),
      )

const parseOrigin = (value: string): Option.Option<string> =>
  pipe(
    parseUrl(value),
    Option.filter((url) => url.pathname === '/' && !url.search && !url.hash && Option.isSome(originSyntax(value))),
    Option.map((url) => url.origin),
  )

const origins = (config: Config): HashSet.HashSet<string> =>
  pipe(
    config.allowedOrigins ?? [],
    Array.map((value) =>
      Option.getOrThrowWith(parseOrigin(value), () => new ConfigError(`Invalid allowed origin: ${value}`)),
    ),
    HashSet.fromIterable,
  )

const evaluate = (request: Request, allowedOrigins: HashSet.HashSet<string>): Decision => {
  if (Array.contains(['GET', 'HEAD', 'OPTIONS'], String.toUpperCase(request.method))) return { allowed: true }
  const target = parseUrl(request.url)
  if (Option.isNone(target)) return { allowed: false, reason: 'invalid-target' }
  const origin = Predicate.isNullish(request.origin) ? Option.none<string>() : parseOrigin(request.origin)
  if (Predicate.isNotNullish(request.origin) && Option.isNone(origin))
    return { allowed: false, reason: 'invalid-origin' }
  const sameOrigin = Option.contains(origin, target.value.origin)
  if (Option.isSome(origin) && !sameOrigin && !HashSet.has(allowedOrigins, origin.value)) {
    return { allowed: false, reason: 'untrusted-origin' }
  }
  const site = request.secFetchSite
  if (
    Predicate.isNotNullish(site) &&
    (!Array.contains(['same-origin', 'same-site', 'cross-site'], site) ||
      (site === 'same-origin' && Option.isSome(origin) && !sameOrigin) ||
      (site === 'cross-site' && sameOrigin))
  )
    return { allowed: false, reason: 'contradictory-metadata' }
  return Option.isSome(origin) || site === 'same-origin'
    ? { allowed: true }
    : { allowed: false, reason: 'missing-proof' }
}

/** Pure CSRF decision. Invalid configuration throws ConfigError, invalid request proof is denied. */
export const decide = (request: Request, config: Config = {}): Decision => evaluate(request, origins(config))

const vary = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse => {
  const existing = pipe(response.headers['vary'] ?? '', String.split(','), Array.map(String.trim))
  if (Array.contains(existing, '*')) return response
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
      const url =
        request.source instanceof globalThis.Request
          ? request.source.url
          : Option.isSome(absoluteHttpUrl(request.originalUrl))
            ? request.originalUrl
            : request.headers['host']
              ? `${request.protocol ?? 'http'}://${request.headers['host']}${String.startsWith('/')(request.originalUrl) ? request.originalUrl : `/${request.originalUrl}`}`
              : ''
      const decision = evaluate(
        {
          method: request.method,
          url,
          origin: request.headers['origin'],
          secFetchSite: request.headers['sec-fetch-site'],
        },
        allowedOrigins,
      )
      if (!decision.allowed)
        return vary(HttpServerResponse.empty({ status: 403, headers: { 'cache-control': 'no-store' } }))
      return vary(yield* app)
    }),
  )
}
