import { Effect } from 'effect'
import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from 'effect/http'

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

export class ConfigError extends Error {
  readonly _tag = 'ConfigError'
}

const parseUrl = (value: string): URL | undefined => {
  for (const character of value) {
    if (character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\') return undefined
  }
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

const parseOrigin = (value: string): string | undefined => {
  const url = parseUrl(value)
  return url && url.pathname === '/' && !url.search && !url.hash && /^https?:\/\/[^/@]+\/?$/iu.test(value)
    ? url.origin
    : undefined
}

const origins = (config: Config): ReadonlySet<string> =>
  new Set(
    (config.allowedOrigins ?? []).map((value) => {
      const origin = parseOrigin(value)
      if (origin === undefined) throw new ConfigError(`Invalid allowed origin: ${value}`)
      return origin
    }),
  )

const evaluate = (request: Request, allowedOrigins: ReadonlySet<string>): Decision => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return { allowed: true }
  const target = parseUrl(request.url)?.origin
  if (target === undefined) return { allowed: false, reason: 'invalid-target' }
  const origin = request.origin === undefined ? undefined : parseOrigin(request.origin)
  if (request.origin !== undefined && origin === undefined) return { allowed: false, reason: 'invalid-origin' }
  if (origin !== undefined && origin !== target && !allowedOrigins.has(origin)) {
    return { allowed: false, reason: 'untrusted-origin' }
  }
  const site = request.secFetchSite
  if (
    site !== undefined &&
    (!['same-origin', 'same-site', 'cross-site', 'none'].includes(site) ||
      site === 'none' ||
      (site === 'same-origin' && origin !== undefined && origin !== target) ||
      (site === 'cross-site' && origin === target))
  )
    return { allowed: false, reason: 'contradictory-metadata' }
  return origin !== undefined || site === 'same-origin'
    ? { allowed: true }
    : { allowed: false, reason: 'missing-proof' }
}

/** Pure CSRF decision. Invalid configuration throws ConfigError, invalid request proof is denied. */
export const decide = (request: Request, config: Config = {}): Decision => evaluate(request, origins(config))

const vary = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse => {
  const existing = response.headers['vary']
  if (existing?.split(',').some((name) => name.trim() === '*')) return response
  const names = new Map(
    (existing ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), name]),
  )
  names.set('origin', 'Origin')
  names.set('sec-fetch-site', 'Sec-Fetch-Site')
  return HttpServerResponse.setHeader(response, 'vary', [...names.values()].join(', '))
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
          : /^https?:\/\//iu.test(request.originalUrl)
            ? request.originalUrl
            : request.headers['host']
              ? `${request.protocol ?? 'http'}://${request.headers['host']}${request.originalUrl.startsWith('/') ? request.originalUrl : `/${request.originalUrl}`}`
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
