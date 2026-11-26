// oxlint-disable-next-line eslint/max-classes-per-file -- The module exports separate tagged errors for input parsing and invalid configuration.
import { Array, Data, Effect, Option, Predicate, Record, Result, Schema, String } from 'effect'
import { HttpServerResponse } from 'effect/http'

/* oxlint-disable rules/no-readonly -- The exported interface preserves declaration merging and immutable directives. */
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
/* oxlint-enable rules/no-readonly */

export class ParseError extends Data.TaggedError('CacheControlParseError')<{ reason: string }> {}
export class ConfigError extends Data.TaggedError('CacheControlConfigError')<{ message: string }> {}

const flags = [
  ['public', 'public'],
  ['private', 'private'],
  ['no-cache', 'noCache'],
  ['no-store', 'noStore'],
  ['must-revalidate', 'mustRevalidate'],
  ['proxy-revalidate', 'proxyRevalidate'],
  ['immutable', 'immutable'],
  ['no-transform', 'noTransform'],
  ['only-if-cached', 'onlyIfCached'],
] as const satisfies Readonly<[string, keyof Directives][]>
const seconds = [
  ['max-age', 'maxAge'],
  ['s-maxage', 'sMaxAge'],
  ['min-fresh', 'minFresh'],
] as const satisfies Readonly<[string, keyof Directives][]>
const invalid = (reason: string): Result.Result<never, ParseError> => Result.fail(new ParseError({ reason }))

const maximumHeaderLength = 8192
const maximumDirectiveCount = 64
const minimumSeconds = 0
const CacheControlHeader = Schema.String.check(
  Schema.isMaxLength(maximumHeaderLength),
  Schema.isPattern(/^[\t\u0020-\u007E]*$(?![\s\S])/u),
).pipe(Schema.brand('CacheControlHeader'))
const DirectiveParts = Schema.Array(Schema.String)
  .check(Schema.isMaxLength(maximumDirectiveCount))
  .pipe(Schema.brand('DirectiveParts'))
const DirectiveName = Schema.String.check(Schema.isPattern(/^[!#$%&'*+.^_`|~\w-]+$(?![\s\S])/u)).pipe(
  Schema.brand('CacheControlDirectiveName'),
)
const DirectiveValue = Schema.String.check(Schema.isPattern(/^(?:\d+|"\d+")$(?![\s\S])/u)).pipe(
  Schema.brand('CacheControlDirectiveValue'),
)
const Seconds = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimumSeconds)).pipe(
  Schema.brand('CacheControlSeconds'),
)

const decodeHeader = Schema.decodeUnknownOption(CacheControlHeader)
const decodeParts = Schema.decodeUnknownOption(DirectiveParts)
const decodeName = Schema.decodeUnknownOption(DirectiveName)
const decodeValue = Schema.decodeUnknownOption(DirectiveValue)
const decodeSeconds = Schema.decodeUnknownOption(Seconds)
const splitDirective = String.match(/^[\t ]*(?<name>[^=\t ]+)[\t ]*(?:=[\t ]*(?<value>.*?))?[\t ]*$/u)
const flagKeys = Record.fromEntries(flags)
const secondKeys = Record.fromEntries(seconds)
type FlagKey = (typeof flagKeys)[keyof typeof flagKeys]
type SecondsKey = (typeof secondKeys)[keyof typeof secondKeys]
type ParsedDirectives = Omit<Directives, SecondsKey | 'maxStale'> &
  Readonly<Partial<Record<SecondsKey, typeof Seconds.Type>>> &
  Readonly<{ maxStale?: typeof Seconds.Type | true }>
type DirectiveEntry =
  | Readonly<[FlagKey, true]>
  | Readonly<[SecondsKey | 'maxStale', typeof Seconds.Type]>
  | Readonly<['maxStale', true]>
type SeenDirectives = Readonly<Record<string, DirectiveEntry>>

const emptyDirectives: Result.Result<SeenDirectives, ParseError> = Result.succeed(Record.empty())

const parseSeconds = (
  key: SecondsKey | 'maxStale',
  value: typeof DirectiveValue.Type,
): Result.Result<DirectiveEntry, ParseError> => {
  const number = decodeSeconds(String.replaceAll('"', '')(value))
  return Option.isNone(number) ? invalid('Invalid seconds') : Result.succeed([key, number.value])
}

const parseDirective = (
  name: typeof DirectiveName.Type,
  value: Option.Option<typeof DirectiveValue.Type>,
): Result.Result<DirectiveEntry, ParseError> => {
  const flag = Record.get<string, FlagKey>(flagKeys, name)
  if (Option.isSome(flag)) {
    return Option.isNone(value) ? Result.succeed([flag.value, true]) : invalid(`Unexpected value for ${name}`)
  }

  const duration = Record.get<string, SecondsKey>(secondKeys, name)
  if (Option.isNone(duration) && name !== 'max-stale') {
    return invalid(`Unsupported directive ${name}`)
  }
  if (Option.isNone(value)) {
    return name === 'max-stale' ? Result.succeed(['maxStale', true]) : invalid(`Missing value for ${name}`)
  }

  return parseSeconds(
    Option.getOrElse(duration, (): 'maxStale' => 'maxStale'),
    value.value,
  )
}

const parseMember = (part: string, seen: SeenDirectives): Result.Result<SeenDirectives, ParseError> => {
  const { name: rawName, value: rawValue } = Option.getOrUndefined(splitDirective(part))?.groups ?? {}
  if (Predicate.isNullish(rawName)) {
    return invalid('Malformed directive')
  }
  const name = decodeName(String.toLowerCase(rawName))
  const value = Option.flatMap(Option.fromNullishOr(rawValue), decodeValue)
  if (Option.isNone(name) || (Predicate.isNotNullish(rawValue) && Option.isNone(value))) {
    return invalid('Malformed directive')
  }
  if (Record.has(seen, name.value)) {
    return invalid(`Duplicate ${name.value}`)
  }
  return Result.map(parseDirective(name.value, value), (entry) => Record.set(seen, name.value, entry))
}

const mergeDirectives = (seen: SeenDirectives): Result.Result<ParsedDirectives, ParseError> => {
  const directives: ParsedDirectives = Record.fromEntries(Record.values(seen))
  return directives.public === true && directives.private === true
    ? invalid('Conflicting visibility')
    : Result.succeed(directives)
}

/**
 * Parse at most 8192 code units and 64 directives, rejecting unknown extensions and duplicates.
 * @param {string} input - The Cache-Control field value.
 * @returns {Result.Result<ParsedDirectives, ParseError>} Validated directives or a parsing error.
 */
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

  const entries = Array.reduce(parts.value, emptyDirectives, (state, part) =>
    Result.flatMap(state, (seen) => parseMember(part, seen)),
  )
  return Result.flatMap(entries, mergeDirectives)
}

/**
 * Serialize an application policy. Throws ConfigError when validation fails.
 * @param {Directives} directives - The Cache-Control policy.
 * @returns {string} The Cache-Control field value.
 */
export const format = (directives: Directives): string => {
  const flagParts = Array.flatMap(flags, ([wire, key]) => ((directives[key] ?? false) ? [wire] : []))
  const secondsParts = Array.flatMap(seconds, ([wire, key]) => {
    const value = directives[key]
    return Predicate.isNullish(value) ? [] : [`${wire}=${value}`]
  })
  const { maxStale } = directives
  const staleParts = Predicate.isNullish(maxStale) ? [] : [maxStale === true ? 'max-stale' : `max-stale=${maxStale}`]
  const value = Array.join([...flagParts, ...secondsParts, ...staleParts], ', ')
  if (Result.isFailure(parse(value))) {
    throw new ConfigError({ message: 'Invalid Cache-Control configuration' })
  }
  return value
}

export const middleware = (
  directives: Directives,
): (<E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => {
  const value = format(directives)
  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(handler, (response) => HttpServerResponse.setHeader(response, 'cache-control', value))
}
