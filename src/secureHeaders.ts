import { Array, Data, Effect, Number, Option, Predicate, Record, Schema } from 'effect'
import { HttpMiddleware, HttpServerResponse } from 'effect/http'

/** Static CSP only. Generate application-specific randomness outside this module. */
export type ContentSecurityPolicy = Partial<Readonly<Record<CspDirective, readonly string[]>>>

export interface Config {
  readonly frameOptions?: typeof FrameOptions.Type | false
  readonly referrerPolicy?: typeof ReferrerPolicy.Type | false
  readonly crossOriginOpenerPolicy?: typeof CrossOriginOpenerPolicy.Type | false
  readonly crossOriginResourcePolicy?: typeof CrossOriginResourcePolicy.Type | false
  /** Opt in only when the deployment is HTTPS-only. maxAge is an integer number of seconds. */
  readonly hsts?: { readonly maxAge: number; readonly includeSubDomains?: boolean; readonly preload?: boolean }
  readonly contentSecurityPolicy?: ContentSecurityPolicy
}

export class ConfigError extends Data.TaggedError('ConfigError')<{ readonly message?: string }> {
  constructor(message?: string) {
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

const CspToken = Schema.String.check(Schema.isPattern(/^(?:(?![;,])[\x21-\x7e])+$(?![\s\S])/u)).pipe(
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
const HstsMaxAge = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.brand('HstsMaxAge'))
const HstsFields = Schema.Struct({
  maxAge: HstsMaxAge,
  includeSubDomains: Schema.NullishOr(Schema.Boolean),
  preload: Schema.NullishOr(Schema.Boolean),
})

const decodeCspDirective = Schema.decodeUnknownOption(CspDirectiveName)
const decodeCspToken = Schema.decodeUnknownOption(CspToken)
const decodeHsts = Schema.decodeUnknownOption(HstsFields)

const formatCspDirective = (name: CspDirective, values: readonly (typeof CspToken.Type)[]): string => {
  const isValueless = name === 'upgrade-insecure-requests' || name === 'block-all-mixed-content'
  if (isValueless && !Array.isReadonlyArrayEmpty(values)) throw new ConfigError(`${name} does not accept values`)
  if (!isValueless && name !== 'sandbox' && Array.isReadonlyArrayEmpty(values)) {
    throw new ConfigError(`${name} requires a source expression`)
  }
  if (Array.some(values, (value) => value === "'none'") && Array.length(values) !== 1) {
    throw new ConfigError("'none' must be the only source expression")
  }
  return Array.join([name, ...values], ' ')
}

/** Throws ConfigError for invalid directives or tokens, including delimiter and header injection. */
export const serializeContentSecurityPolicy = (policy: ContentSecurityPolicy): string => {
  const entries = Record.toEntries<string, readonly string[] | undefined>(policy)
  if (Array.isArrayEmpty(entries)) throw new ConfigError('Content Security Policy must contain at least one directive')
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

type Header = readonly [name: string, value: string]

const header = (
  name: string,
  value: string | false,
  decode: (input: unknown) => Option.Option<string>,
): Option.Option<Header> => {
  if (value === false) return Option.none()
  const policy = decode(value)
  if (Option.isNone(policy)) throw new ConfigError(`Invalid ${name} policy`)
  return Option.some([name, policy.value])
}

/** Pure policy serialization. Defaults isolate documents/resources and disclose no referrer. */
export const headers = (config: Config = {}): Readonly<Record<string, string>> => {
  const policies: readonly Option.Option<Header>[] = [
    Option.some(['x-content-type-options', 'nosniff']),
    header('x-frame-options', config.frameOptions ?? 'DENY', Schema.decodeUnknownOption(FrameOptions)),
    header('referrer-policy', config.referrerPolicy ?? 'no-referrer', Schema.decodeUnknownOption(ReferrerPolicy)),
    header(
      'cross-origin-opener-policy',
      config.crossOriginOpenerPolicy ?? 'same-origin',
      Schema.decodeUnknownOption(CrossOriginOpenerPolicy),
    ),
    header(
      'cross-origin-resource-policy',
      config.crossOriginResourcePolicy ?? 'same-origin',
      Schema.decodeUnknownOption(CrossOriginResourcePolicy),
    ),
    Option.map(Option.fromNullishOr(config.hsts), ({ maxAge, includeSubDomains, preload }) => {
      const policy = decodeHsts({ maxAge, includeSubDomains, preload })
      if (Option.isNone(policy)) throw new ConfigError('Invalid HSTS configuration')
      return serializeHsts(policy.value)
    }),
    Option.map(Option.fromNullishOr(config.contentSecurityPolicy), (policy) => [
      'content-security-policy',
      serializeContentSecurityPolicy(policy),
    ]),
  ]
  return Object.freeze(Record.fromEntries(Array.getSomes(policies)))
}

const serializeHsts = ({ maxAge, includeSubDomains, preload }: typeof HstsFields.Type): Header => {
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
