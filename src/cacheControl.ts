import { Array, Data, Effect, Option, Predicate, Record, Result, Schema, String } from 'effect'
import { HttpServerResponse } from 'effect/http'

export interface Directives {
  readonly public?: boolean
  readonly private?: boolean
  readonly noCache?: boolean
  readonly noStore?: boolean
  readonly mustRevalidate?: boolean
  readonly proxyRevalidate?: boolean
  readonly immutable?: boolean
  readonly noTransform?: boolean
  readonly onlyIfCached?: boolean
  readonly maxAge?: number
  readonly sMaxAge?: number
  readonly minFresh?: number
  readonly maxStale?: number | true
}

export class ParseError extends Data.TaggedError('CacheControlParseError')<{ readonly reason: string }> {}
export class ConfigError extends Data.TaggedError('CacheControlConfigError')<{ readonly message: string }> {}

const flags = {
  public: 'public',
  private: 'private',
  'no-cache': 'noCache',
  'no-store': 'noStore',
  'must-revalidate': 'mustRevalidate',
  'proxy-revalidate': 'proxyRevalidate',
  immutable: 'immutable',
  'no-transform': 'noTransform',
  'only-if-cached': 'onlyIfCached',
} satisfies Readonly<Record<string, keyof Directives>>
const seconds = {
  'max-age': 'maxAge',
  's-maxage': 'sMaxAge',
  'min-fresh': 'minFresh',
} satisfies Readonly<Record<string, keyof Directives>>
const invalid = (reason: string): Result.Result<never, ParseError> => Result.fail(new ParseError({ reason }))

const CacheControlHeader = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[\t\u0020-\u007E]*$(?![\s\S])/u),
).pipe(Schema.brand('CacheControlHeader'))
const DirectiveParts = Schema.Array(Schema.String).check(Schema.isMaxLength(64)).pipe(Schema.brand('DirectiveParts'))
const DirectiveName = Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~\w-]+$(?![\s\S])/u)).pipe(
  Schema.brand('CacheControlDirectiveName'),
)
const DirectiveValue = Schema.String.check(Schema.isPattern(/^(?:\d+|"\d+")$(?![\s\S])/u)).pipe(
  Schema.brand('CacheControlDirectiveValue'),
)
const Seconds = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).pipe(
  Schema.brand('CacheControlSeconds'),
)

const decodeHeader = Schema.decodeUnknownOption(CacheControlHeader)
const decodeParts = Schema.decodeUnknownOption(DirectiveParts)
const decodeName = Schema.decodeUnknownOption(DirectiveName)
const decodeValue = Schema.decodeUnknownOption(DirectiveValue)
const decodeSeconds = Schema.decodeUnknownOption(Seconds)
const splitDirective = String.match(/^[\t ]*(?<name>[^=\t ]+)[\t ]*(?:=[\t ]*(?<value>.*?))?[\t ]*$/u)
type FlagKey = (typeof flags)[keyof typeof flags]
type SecondsKey = (typeof seconds)[keyof typeof seconds]
type ParsedDirectives = Omit<Directives, SecondsKey | 'maxStale'> & {
  readonly [K in SecondsKey]?: typeof Seconds.Type
} & { readonly maxStale?: typeof Seconds.Type | true }
type DirectiveEntry =
  | readonly [FlagKey, true]
  | readonly [SecondsKey | 'maxStale', typeof Seconds.Type]
  | readonly ['maxStale', true]

const parseDirective = (
  name: typeof DirectiveName.Type,
  value: Option.Option<typeof DirectiveValue.Type>,
): Result.Result<DirectiveEntry, ParseError> => {
  const flag = Record.get<string, FlagKey>(flags, name)
  if (Option.isSome(flag)) {
    return Option.isNone(value) ? Result.succeed([flag.value, true]) : invalid(`Unexpected value for ${name}`)
  }

  const duration = Record.get<string, SecondsKey>(seconds, name)
  if (Option.isNone(duration) && name !== 'max-stale') {
    return invalid(`Unsupported directive ${name}`)
  }
  if (Option.isNone(value)) {
    return name === 'max-stale' ? Result.succeed(['maxStale', true]) : invalid(`Missing value for ${name}`)
  }

  const number = decodeSeconds(String.replaceAll('"', '')(value.value))
  if (Option.isNone(number)) {
    return invalid('Invalid seconds')
  }
  return Result.succeed([Option.getOrElse(duration, (): 'maxStale' => 'maxStale'), number.value])
}

/** Unknown extensions and duplicates are rejected. Input is limited to 8192 code units and 64 directives. */
export const parse = (input: string): Result.Result<ParsedDirectives, ParseError> => {
  const header = decodeHeader(input)
  if (Option.isNone(header)) {
    return invalid('Invalid header bytes or length')
  }
  const parts = decodeParts(String.split(header.value, ','))
  if (Option.isNone(parts)) {
    return invalid('Too many directives')
  }
  if (String.isEmpty(String.trim(header.value))) {
    return invalid('Empty Cache-Control')
  }

  const empty: Result.Result<Readonly<Record<string, DirectiveEntry>>, ParseError> = Result.succeed(Record.empty())
  const entries = Array.reduce(parts.value, empty, (state, part) =>
    Result.flatMap(state, (seen) => {
      const match = Option.getOrUndefined(splitDirective(part))
      const rawName = match?.groups?.['name']
      if (Predicate.isNullish(rawName)) {
        return invalid('Malformed directive')
      }
      const name = decodeName(String.toLowerCase(rawName))
      const rawValue = match?.groups?.['value']
      const value = Option.flatMap(Option.fromNullishOr(rawValue), decodeValue)
      if (Option.isNone(name) || (Predicate.isNotNullish(rawValue) && Option.isNone(value))) {
        return invalid('Malformed directive')
      }
      if (Record.has(seen, name.value)) {
        return invalid(`Duplicate ${name.value}`)
      }
      return Result.map(parseDirective(name.value, value), (entry) => Record.set(seen, name.value, entry))
    }),
  )
  if (Result.isFailure(entries)) {
    return Result.fail(entries.failure)
  }
  const directives: ParsedDirectives = Record.fromEntries(Record.values(entries.success))
  if (directives.public && directives.private) {
    return invalid('Conflicting visibility')
  }
  return Result.succeed(directives)
}

/** Throws ConfigError on invalid application configuration rather than emitting a permissive policy. */
export const format = (directives: Directives): string => {
  const flagParts = Array.flatMap(Record.toEntries(flags), ([wire, key]) => (directives[key] ? [wire] : []))
  const secondsParts = Array.flatMap(Record.toEntries(seconds), ([wire, key]) => {
    const value = directives[key]
    return Predicate.isNullish(value) ? [] : [`${wire}=${value}`]
  })
  const maxStale = directives.maxStale
  const staleParts = Predicate.isNullish(maxStale) ? [] : [maxStale === true ? 'max-stale' : `max-stale=${maxStale}`]
  const value = Array.join([...flagParts, ...secondsParts, ...staleParts], ', ')
  if (Result.isFailure(parse(value))) {
    throw new ConfigError({ message: 'Invalid Cache-Control configuration' })
  }
  return value
}

export const middleware = (directives: Directives) => {
  const value = format(directives)
  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(handler, (response) => HttpServerResponse.setHeader(response, 'cache-control', value))
}
