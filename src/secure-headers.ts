import { Array, Data, Effect, Number, Option, Predicate, Record, Schema } from 'effect'
import { HttpMiddleware, HttpServerResponse } from 'effect/http'

/** Static CSP only. Generate application-specific randomness outside this module. */
export type ContentSecurityPolicy = Partial<Readonly<Record<CspDirective, Readonly<string[]>>>>

/* oxlint-disable rules/no-readonly -- The exported interface preserves declaration merging and immutable options. */
export interface Config {
  readonly frameOptions?: typeof FrameOptions.Type | false
  readonly referrerPolicy?: typeof ReferrerPolicy.Type | false
  readonly crossOriginOpenerPolicy?: typeof CrossOriginOpenerPolicy.Type | false
  readonly crossOriginResourcePolicy?: typeof CrossOriginResourcePolicy.Type | false
  /** Opt in only when the deployment is HTTPS-only. maxAge is an integer number of seconds. */
  readonly hsts?: { readonly maxAge: number; readonly includeSubDomains?: boolean; readonly preload?: boolean }
  readonly contentSecurityPolicy?: ContentSecurityPolicy
}
/* oxlint-enable rules/no-readonly */

export class ConfigError extends Data.TaggedError('ConfigError')<{ message?: string }> {
  public constructor(message?: string) {
    super(Predicate.isNullish(message) ? {} : { message })
  }
}

const CspDirectiveName = Schema.Literals([
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
export type CspDirective = typeof CspDirectiveName.Type

const CspToken = Schema.String.check(Schema.isPattern(/^(?:(?![;,])[\u0021-\u007E])+$(?![\s\S])/u)).pipe(
  Schema.brand('CspToken'),
)
const FrameOptions = Schema.Literals(['DENY', 'SAMEORIGIN'])
const ReferrerPolicy = Schema.Literals([
  'no-referrer',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
])
const CrossOriginOpenerPolicy = Schema.Literals(['same-origin', 'same-origin-allow-popups', 'unsafe-none'])
const CrossOriginResourcePolicy = Schema.Literals(['same-origin', 'same-site', 'cross-origin'])
const HstsMaxAge = Schema.Natural.pipe(Schema.brand('HstsMaxAge'))
const HstsFields = Schema.Struct({
  includeSubDomains: Schema.NullishOr(Schema.Boolean),
  maxAge: HstsMaxAge,
  preload: Schema.NullishOr(Schema.Boolean),
})

const decodeCspDirective = Schema.decodeUnknownOption(CspDirectiveName)
const decodeCspToken = Schema.decodeUnknownOption(CspToken)
const decodeFrameOptions = Schema.decodeUnknownOption(FrameOptions)
const decodeReferrerPolicy = Schema.decodeUnknownOption(ReferrerPolicy)
const decodeCrossOriginOpenerPolicy = Schema.decodeUnknownOption(CrossOriginOpenerPolicy)
const decodeCrossOriginResourcePolicy = Schema.decodeUnknownOption(CrossOriginResourcePolicy)
const decodeHsts = Schema.decodeUnknownOption(HstsFields)

const singleCspSource = 1
const formatCspDirective = (name: CspDirective, values: Readonly<(typeof CspToken.Type)[]>): string => {
  const isValueless = name === 'upgrade-insecure-requests' || name === 'block-all-mixed-content'
  if (isValueless && !Array.isReadonlyArrayEmpty(values)) {
    throw new ConfigError(`${name} does not accept values`)
  }
  if (!isValueless && name !== 'sandbox' && Array.isReadonlyArrayEmpty(values)) {
    throw new ConfigError(`${name} requires a source expression`)
  }
  if (Array.some(values, (value) => value === "'none'") && Array.length(values) !== singleCspSource) {
    throw new ConfigError("'none' must be the only source expression")
  }
  return Array.join([name, ...values], ' ')
}

/**
 * Serialize a static Content Security Policy. Throws ConfigError for invalid directives or tokens.
 * @param {ContentSecurityPolicy} policy - Directives and source expressions.
 * @returns {string} The Content-Security-Policy header value.
 */
export const serializeContentSecurityPolicy = (policy: ContentSecurityPolicy): string => {
  const entries = Record.toEntries<string, Readonly<string[]> | undefined>(policy)
  if (Array.isArrayEmpty(entries)) {
    throw new ConfigError('Content Security Policy must contain at least one directive')
  }
  const serialized = Array.map(entries, ([name, values]) => {
    const directive = decodeCspDirective(name)
    if (Option.isNone(directive) || !Array.isArray(values)) {
      throw new ConfigError(`Invalid CSP directive: ${name}`)
    }
    const tokens = Array.map(values, (value) =>
      Option.getOrThrowWith(decodeCspToken(value), () => new ConfigError(`Invalid CSP value for ${name}`)),
    )
    return formatCspDirective(directive.value, tokens)
  })
  return Array.join(serialized, '; ')
}

type Header = Readonly<[name: string, value: string]>

const header = (
  name: string,
  value: string | false,
  decode: (input: unknown) => Option.Option<string>,
): Option.Option<Header> => {
  if (value === false) {
    return Option.none()
  }
  const policy = decode(value)
  if (Option.isNone(policy)) {
    throw new ConfigError(`Invalid ${name} policy`)
  }
  return Option.some([name, policy.value])
}

const minimumHstsPreloadAgeSeconds = 31_536_000
const serializeHsts = ({ maxAge, includeSubDomains, preload }: typeof HstsFields.Type): Header => {
  if (preload === true && (includeSubDomains !== true || Number.isLessThan(maxAge, minimumHstsPreloadAgeSeconds))) {
    throw new ConfigError('HSTS preload requires subdomains and at least one year')
  }
  return [
    'strict-transport-security',
    `max-age=${maxAge}${includeSubDomains === true ? '; includeSubDomains' : ''}${preload === true ? '; preload' : ''}`,
  ]
}

/**
 * Serialize security policies. Defaults isolate documents and resources and disclose no referrer.
 * @param {Config} config - Policies to override or disable.
 * @returns {Readonly<Record<string, string>>} Immutable response header fields.
 */
export const headers = (config: Config = {}): Readonly<Record<string, string>> => {
  const policies: Option.Option<Header>[] = [
    Option.some(['x-content-type-options', 'nosniff']),
    header('x-frame-options', config.frameOptions ?? 'DENY', decodeFrameOptions),
    header('referrer-policy', config.referrerPolicy ?? 'no-referrer', decodeReferrerPolicy),
    header(
      'cross-origin-opener-policy',
      config.crossOriginOpenerPolicy ?? 'same-origin',
      decodeCrossOriginOpenerPolicy,
    ),
    header(
      'cross-origin-resource-policy',
      config.crossOriginResourcePolicy ?? 'same-origin',
      decodeCrossOriginResourcePolicy,
    ),
    Option.map(Option.fromNullishOr(config.hsts), ({ maxAge, includeSubDomains, preload }) => {
      const policy = decodeHsts({ includeSubDomains, maxAge, preload })
      if (Option.isNone(policy)) {
        throw new ConfigError('Invalid HSTS configuration')
      }
      return serializeHsts(policy.value)
    }),
    Option.map(Option.fromNullishOr(config.contentSecurityPolicy), (policy) => [
      'content-security-policy',
      serializeContentSecurityPolicy(policy),
    ]),
  ]
  return Object.freeze(Record.fromEntries(Array.getSomes(policies)))
}

/**
 * Validate once at construction, then apply the policy and remove framework disclosure.
 * @param {Config} config - Policies to apply to each response.
 * @returns {HttpMiddleware.HttpMiddleware} Middleware that preserves the handler's errors and service requirements.
 */
export const middleware = (
  config: Config = {},
): (<E, R>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => {
  const policy = headers(config)
  return HttpMiddleware.make(<E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(app, (response) =>
      HttpServerResponse.setHeaders(HttpServerResponse.removeHeader(response, 'x-powered-by'), policy),
    ),
  )
}
