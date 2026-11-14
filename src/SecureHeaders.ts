import { Effect } from 'effect'
import { HttpMiddleware, HttpServerResponse } from 'effect/http'

export type CspDirective =
  | 'default-src'
  | 'base-uri'
  | 'child-src'
  | 'connect-src'
  | 'font-src'
  | 'form-action'
  | 'frame-ancestors'
  | 'frame-src'
  | 'img-src'
  | 'manifest-src'
  | 'media-src'
  | 'object-src'
  | 'script-src'
  | 'script-src-attr'
  | 'script-src-elem'
  | 'style-src'
  | 'style-src-attr'
  | 'style-src-elem'
  | 'worker-src'
  | 'sandbox'
  | 'upgrade-insecure-requests'
  | 'block-all-mixed-content'

/** Static CSP only. Generate application-specific randomness outside this module. */
export type ContentSecurityPolicy = Partial<Readonly<Record<CspDirective, readonly string[]>>>

export interface Config {
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false
  readonly referrerPolicy?: 'no-referrer' | 'same-origin' | 'strict-origin' | 'strict-origin-when-cross-origin' | false
  readonly crossOriginOpenerPolicy?: 'same-origin' | 'same-origin-allow-popups' | 'unsafe-none' | false
  readonly crossOriginResourcePolicy?: 'same-origin' | 'same-site' | 'cross-origin' | false
  /** Opt in only when the deployment is HTTPS-only. maxAge is an integer number of seconds. */
  readonly hsts?: { readonly maxAge: number; readonly includeSubDomains?: boolean; readonly preload?: boolean }
  readonly contentSecurityPolicy?: ContentSecurityPolicy
}

export class ConfigError extends Error {
  readonly _tag = 'ConfigError'
}

const directives: ReadonlySet<string> = new Set<CspDirective>([
  'default-src',
  'base-uri',
  'child-src',
  'connect-src',
  'font-src',
  'form-action',
  'frame-ancestors',
  'frame-src',
  'img-src',
  'manifest-src',
  'media-src',
  'object-src',
  'script-src',
  'script-src-attr',
  'script-src-elem',
  'style-src',
  'style-src-attr',
  'style-src-elem',
  'worker-src',
  'sandbox',
  'upgrade-insecure-requests',
  'block-all-mixed-content',
])

/** Throws ConfigError for invalid directives or tokens, including delimiter and header injection. */
export const serializeContentSecurityPolicy = (policy: ContentSecurityPolicy): string => {
  const entries = Object.entries(policy)
  if (entries.length === 0) throw new ConfigError('Content Security Policy must contain at least one directive')
  return entries
    .map(([name, values]) => {
      if (!directives.has(name) || !Array.isArray(values)) throw new ConfigError(`Invalid CSP directive: ${name}`)
      if (
        values.some(
          (value: unknown) => typeof value !== 'string' || value.length === 0 || /[^\x21-\x7e]|[;,]/u.test(value),
        )
      ) {
        throw new ConfigError(`Invalid CSP value for ${name}`)
      }
      if ((name === 'upgrade-insecure-requests' || name === 'block-all-mixed-content') && values.length !== 0) {
        throw new ConfigError(`${name} does not accept values`)
      }
      if (
        name !== 'sandbox' &&
        name !== 'upgrade-insecure-requests' &&
        name !== 'block-all-mixed-content' &&
        values.length === 0
      ) {
        throw new ConfigError(`${name} requires a source expression`)
      }
      if (values.includes("'none'") && values.length !== 1)
        throw new ConfigError("'none' must be the only source expression")
      return [name, ...values].join(' ')
    })
    .join('; ')
}

const header = (
  result: Record<string, string>,
  name: string,
  value: string | false,
  allowed: readonly string[],
): void => {
  if (value === false) return
  if (!allowed.includes(value)) throw new ConfigError(`Invalid ${name} policy`)
  result[name] = value
}

/** Pure policy serialization. Defaults isolate documents/resources and disclose no referrer. */
export const headers = (config: Config = {}): Readonly<Record<string, string>> => {
  const result: Record<string, string> = { 'x-content-type-options': 'nosniff' }
  header(result, 'x-frame-options', config.frameOptions ?? 'DENY', ['DENY', 'SAMEORIGIN'])
  header(result, 'referrer-policy', config.referrerPolicy ?? 'no-referrer', [
    'no-referrer',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
  ])
  header(result, 'cross-origin-opener-policy', config.crossOriginOpenerPolicy ?? 'same-origin', [
    'same-origin',
    'same-origin-allow-popups',
    'unsafe-none',
  ])
  header(result, 'cross-origin-resource-policy', config.crossOriginResourcePolicy ?? 'same-origin', [
    'same-origin',
    'same-site',
    'cross-origin',
  ])
  if (config.hsts !== undefined) {
    const { maxAge, includeSubDomains, preload } = config.hsts
    if (
      !Number.isSafeInteger(maxAge) ||
      maxAge < 0 ||
      (includeSubDomains !== undefined && typeof includeSubDomains !== 'boolean') ||
      (preload !== undefined && typeof preload !== 'boolean')
    )
      throw new ConfigError('Invalid HSTS configuration')
    if (preload && (!includeSubDomains || maxAge < 31536000))
      throw new ConfigError('HSTS preload requires subdomains and at least one year')
    result['strict-transport-security'] =
      `max-age=${maxAge}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`
  }
  if (config.contentSecurityPolicy !== undefined)
    result['content-security-policy'] = serializeContentSecurityPolicy(config.contentSecurityPolicy)
  return Object.freeze(result)
}

/** Validates once at construction, then applies policy and removes framework disclosure. */
export const middleware = (config: Config = {}) => {
  const policy = headers(config)
  return HttpMiddleware.make(<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(app, (response) =>
      HttpServerResponse.setHeaders(HttpServerResponse.removeHeader(response, 'x-powered-by'), policy),
    ),
  )
}
