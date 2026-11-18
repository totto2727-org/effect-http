import { Array, Data, Effect, Number, Option, Predicate, Record, Result, Schema, String } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

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
} as const
const seconds = { 'max-age': 'maxAge', 's-maxage': 'sMaxAge', 'min-fresh': 'minFresh' } as const
const invalid = (reason: string): Result.Result<never, ParseError> => Result.fail(new ParseError({ reason }))
const isSafeInteger = Schema.is(Schema.Int)
const invalidHeaderBytes = String.match(/[^\t\x20-\x7e]/)
const matchDirective = String.match(/^[\t ]*([!#$%&'*+.^_`|~\w-]+)(?:[\t ]*=[\t ]*(\d+|"\d+"))?[\t ]*$/)
type FlagKey = (typeof flags)[keyof typeof flags]
type SecondsKey = (typeof seconds)[keyof typeof seconds]
type DirectiveEntry =
  | readonly [FlagKey, true]
  | readonly [SecondsKey | 'maxStale', number]
  | readonly ['maxStale', true]

const parseDirective = (name: string, value: string | undefined): Result.Result<DirectiveEntry, ParseError> => {
  const flag = Record.get<string, FlagKey>(flags, name)
  if (Option.isSome(flag)) {
    return Predicate.isNullish(value) ? Result.succeed([flag.value, true]) : invalid(`Unexpected value for ${name}`)
  }

  const duration = Record.get<string, SecondsKey>(seconds, name)
  if (Option.isNone(duration) && name !== 'max-stale') return invalid(`Unsupported directive ${name}`)
  if (Predicate.isNullish(value)) {
    return name === 'max-stale' ? Result.succeed(['maxStale', true]) : invalid(`Missing value for ${name}`)
  }

  const number = Option.getOrUndefined(Number.parse(String.replaceAll('"', '')(value)))
  if (!isSafeInteger(number) || Number.isLessThan(number, 0)) return invalid('Invalid seconds')
  return Result.succeed([Option.getOrElse(duration, () => 'maxStale' as const), number])
}

/** Unknown extensions and duplicates are rejected. Input is limited to 8192 code units and 64 directives. */
export const parse = (input: string): Result.Result<Directives, ParseError> => {
  if (String.length(input) > 8192 || Option.isSome(invalidHeaderBytes(input))) {
    return invalid('Invalid header bytes or length')
  }
  const parts = String.split(input, ',')
  if (Array.length(parts) > 64) return invalid('Too many directives')
  if (String.isEmpty(String.trim(input))) return invalid('Empty Cache-Control')

  const empty: Result.Result<Readonly<Record<string, DirectiveEntry>>, ParseError> = Result.succeed(Record.empty())
  const entries = Array.reduce(parts, empty, (state, part) =>
    Result.flatMap(state, (seen) => {
      const match = Option.getOrUndefined(matchDirective(part))
      if (!match?.[1]) return invalid('Malformed directive')
      const name = String.toLowerCase(match[1])
      if (Record.has(seen, name)) return invalid(`Duplicate ${name}`)
      return Result.map(parseDirective(name, match[2]), (entry) => Record.set(seen, name, entry))
    }),
  )
  if (Result.isFailure(entries)) return Result.fail(entries.failure)
  const directives: Directives = Record.fromEntries(Record.values(entries.success))
  if (directives.public && directives.private) return invalid('Conflicting visibility')
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
  if (Result.isFailure(parse(value))) throw new ConfigError({ message: 'Invalid Cache-Control configuration' })
  return value
}

export const middleware = (directives: Directives) => {
  const value = format(directives)
  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(handler, (response) => HttpServerResponse.setHeader(response, 'cache-control', value))
}
