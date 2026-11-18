import { Array, Data, Effect, Number, Option, Predicate, Record, Schema, String } from 'effect'
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

export class ConfigError extends Data.TaggedError('ConfigError')<{ readonly message?: string }> {
  constructor(message?: string) {
    super(message === undefined ? {} : { message })
  }
}

const directives: readonly CspDirective[] = [
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
]

const invalidCspToken = String.match(/[^\x21-\x7e]|[;,]/u)
const isSafeInteger = Schema.is(Schema.Int)

/** Throws ConfigError for invalid directives or tokens, including delimiter and header injection. */
export const serializeContentSecurityPolicy = (policy: ContentSecurityPolicy): string => {
  const entries = Record.toEntries<string, readonly string[] | undefined>(policy)
  if (Array.isArrayEmpty(entries)) throw new ConfigError('Content Security Policy must contain at least one directive')
  const serialized = Array.map(entries, ([name, values]) => {
    if (!Array.some(directives, (directive) => directive === name) || !Array.isArray(values)) {
      throw new ConfigError(`Invalid CSP directive: ${name}`)
    }
    if (
      Array.some(
        values,
        (value: unknown) =>
          !Predicate.isString(value) || String.isEmpty(value) || Option.isSome(invalidCspToken(value)),
      )
    ) {
      throw new ConfigError(`Invalid CSP value for ${name}`)
    }
    const isValueless = name === 'upgrade-insecure-requests' || name === 'block-all-mixed-content'
    if (isValueless && !Array.isReadonlyArrayEmpty(values)) throw new ConfigError(`${name} does not accept values`)
    if (!isValueless && name !== 'sandbox' && Array.isReadonlyArrayEmpty(values)) {
      throw new ConfigError(`${name} requires a source expression`)
    }
    if (Array.some(values, (value) => value === "'none'") && Array.length(values) !== 1) {
      throw new ConfigError("'none' must be the only source expression")
    }
    return Array.join([name, ...values], ' ')
  })
  return Array.join(serialized, '; ')
}

type Header = readonly [name: string, value: string]

const header = (name: string, value: string | false, allowed: readonly string[]): Option.Option<Header> => {
  if (value === false) return Option.none()
  if (!Array.some(allowed, (policy) => policy === value)) throw new ConfigError(`Invalid ${name} policy`)
  return Option.some([name, value])
}

/** Pure policy serialization. Defaults isolate documents/resources and disclose no referrer. */
export const headers = (config: Config = {}): Readonly<Record<string, string>> => {
  const policies: readonly Option.Option<Header>[] = [
    Option.some(['x-content-type-options', 'nosniff']),
    header('x-frame-options', config.frameOptions ?? 'DENY', ['DENY', 'SAMEORIGIN']),
    header('referrer-policy', config.referrerPolicy ?? 'no-referrer', [
      'no-referrer',
      'same-origin',
      'strict-origin',
      'strict-origin-when-cross-origin',
    ]),
    header('cross-origin-opener-policy', config.crossOriginOpenerPolicy ?? 'same-origin', [
      'same-origin',
      'same-origin-allow-popups',
      'unsafe-none',
    ]),
    header('cross-origin-resource-policy', config.crossOriginResourcePolicy ?? 'same-origin', [
      'same-origin',
      'same-site',
      'cross-origin',
    ]),
    Option.map(Option.fromUndefinedOr(config.hsts), serializeHsts),
    Option.map(Option.fromUndefinedOr(config.contentSecurityPolicy), (policy) => [
      'content-security-policy',
      serializeContentSecurityPolicy(policy),
    ]),
  ]
  return Object.freeze(Record.fromEntries(Array.getSomes(policies)))
}

const serializeHsts = ({ maxAge, includeSubDomains, preload }: NonNullable<Config['hsts']>): Header => {
  if (
    !isSafeInteger(maxAge) ||
    Number.isLessThan(maxAge, 0) ||
    (includeSubDomains !== undefined && !Predicate.isBoolean(includeSubDomains)) ||
    (preload !== undefined && !Predicate.isBoolean(preload))
  )
    throw new ConfigError('Invalid HSTS configuration')
  if (preload && (!includeSubDomains || Number.isLessThan(maxAge, 31536000)))
    throw new ConfigError('HSTS preload requires subdomains and at least one year')
  return [
    'strict-transport-security',
    `max-age=${maxAge}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`,
  ]
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
