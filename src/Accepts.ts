import { Array, Data, Effect, Iterable, Number, Option, Predicate, Record, Result, String, pipe } from 'effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'

/** The four independent HTTP preference grammars. */
export type Kind = 'mediaType' | 'language' | 'encoding' | 'charset'

export class ParseError extends Data.TaggedError('AcceptsParseError')<{
  readonly kind: Kind
  readonly reason: string
}> {}

export interface Preference {
  readonly value: string
  readonly parameters: Readonly<Record<string, string>>
  readonly quality: number
}

export interface Parsed {
  readonly kind: Kind
  readonly missing: boolean
  readonly preferences: ReadonlyArray<Preference>
}

const names = {
  mediaType: 'accept',
  language: 'accept-language',
  encoding: 'accept-encoding',
  charset: 'accept-charset',
} satisfies Record<Kind, string>

const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const language = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/
const quality = /^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/
const matches = (pattern: RegExp, input: string): boolean => Option.isSome(String.match(pattern)(input))
const isBoundedAscii = (input: string): boolean => input.length <= 8192 && !matches(/[^\x20-\x7e\t]/, input)
const invalid = (kind: Kind, reason: string): Result.Result<never, ParseError> =>
  Result.fail(new ParseError({ kind, reason }))

// Delimiters in quoted strings are data, not list or parameter separators.
const split = (input: string, delimiter: ',' | ';'): ReadonlyArray<string> | undefined => {
  // The optional closing quote lets the scan report an unterminated string instead of skipping it.
  const markers = Array.fromIterable(String.matchAll(/"(?:[^"\\]|\\.)*(")?|[;,]/g)(input))
  if (Array.some(markers, ([marker, closing]) => String.startsWith('"')(marker) && Predicate.isNullish(closing))) {
    return undefined
  }
  const separators = Array.filterMap(markers, ({ 0: marker, index }) =>
    marker === delimiter && Predicate.isNotNullish(index) ? Result.succeed(index) : Result.fail(undefined),
  )
  return Array.zipWith(Array.prepend(separators, -1), Array.append(separators, input.length), (left, right) =>
    pipe(input, String.slice(left + 1, right), String.trim),
  )
}

const parameterValue = (input: string): string | undefined => {
  if (matches(token, input)) return input
  if (!matches(/^"(?:[^"\\]|\\.)*"$/, input)) return undefined
  return pipe(input, String.slice(1, -1), String.replaceAll(/\\(.)/g, '$1'))
}

const validValue = (kind: Kind, value: string, offered: boolean): boolean => {
  if (kind === 'mediaType') {
    const [type, subtype, extra] = String.split(value, '/')
    return (
      Predicate.isNotNullish(type) &&
      Predicate.isNotNullish(subtype) &&
      Predicate.isNullish(extra) &&
      matches(token, type) &&
      matches(token, subtype) &&
      (!String.includes('*')(type) || type === '*') &&
      (!String.includes('*')(subtype) || subtype === '*') &&
      (type !== '*' || subtype === '*') &&
      (!offered || (type !== '*' && subtype !== '*'))
    )
  }
  if (value === '*') return !offered
  return kind === 'language' ? matches(language, value) : matches(token, value) && !String.includes('*')(value)
}

interface Parameters {
  readonly values: Readonly<Record<string, string>>
  readonly quality: Option.Option<number>
}

const parseParameter = (
  kind: Kind,
  offered: boolean,
  parameters: Parameters,
  part: string,
): Result.Result<Parameters, ParseError> => {
  const equals = String.indexOf('=')(part)
  if (Option.isNone(equals) || equals.value < 1) return invalid(kind, 'Invalid parameter')
  const name = pipe(part, String.slice(0, equals.value), String.trim, String.toLowerCase)
  const raw = pipe(part, String.slice(equals.value + 1), String.trim)
  if (!matches(token, name)) return invalid(kind, 'Invalid parameter')
  if (name === 'q') {
    if (offered || Option.isSome(parameters.quality) || !matches(quality, raw)) return invalid(kind, 'Invalid quality')
    return Result.succeed({ ...parameters, quality: Number.parse(raw) })
  }
  // Accept extensions after q are deliberately rejected rather than silently ignored.
  if (kind !== 'mediaType' || Option.isSome(parameters.quality) || Record.has(parameters.values, name)) {
    return invalid(kind, 'Unsupported or duplicate parameter')
  }
  const decoded = parameterValue(raw)
  if (Predicate.isNullish(decoded)) return invalid(kind, 'Invalid parameter value')
  return Result.succeed({
    ...parameters,
    values: Record.set(parameters.values, name, name === 'charset' ? String.toLowerCase(decoded) : decoded),
  })
}

const parsePreference = (kind: Kind, input: string, offered: boolean): Result.Result<Preference, ParseError> => {
  const parts = split(input, ';')
  if (Predicate.isNullish(parts) || parts.length > 129) return invalid(kind, 'Invalid preference value')
  const [rawValue, ...rawParameters] = parts
  const value = String.toLowerCase(rawValue ?? '')
  if (!validValue(kind, value, offered)) {
    return invalid(kind, 'Invalid preference value')
  }
  const initial: Result.Result<Parameters, ParseError> = Result.succeed({
    values: Record.empty(),
    quality: Option.none(),
  })
  return pipe(
    rawParameters,
    Array.reduce(initial, (state, part) =>
      Result.flatMap(state, (parameters) => parseParameter(kind, offered, parameters, part)),
    ),
    Result.map(({ values, quality }) => ({
      value,
      parameters: values,
      quality: Option.getOrElse(quality, () => 1),
    })),
  )
}

/**
 * Strict, bounded parsing: at most 8192 ASCII characters, 128 preferences and 128 parameters per preference.
 * Missing headers accept any offer. Empty headers accept none, except that encoding
 * still allows identity. Invalid syntax fails the entire header, never a permissive subset.
 * q must be an unquoted RFC quality with at most three decimals. Duplicate parameters,
 * empty list members, and Accept extensions after q are rejected.
 */
export const parse = (kind: Kind, header: string | null | undefined): Result.Result<Parsed, ParseError> => {
  if (Predicate.isNullish(header)) return Result.succeed({ kind, missing: true, preferences: [] })
  if (!isBoundedAscii(header)) return invalid(kind, 'Invalid or oversized header')
  if (String.trim(header) === '') return Result.succeed({ kind, missing: false, preferences: [] })
  const members = split(header, ',')
  if (Predicate.isNullish(members) || members.length > 128) return invalid(kind, 'Invalid or excessive preference list')
  return pipe(
    members,
    Iterable.map((member) => parsePreference(kind, member, false)),
    Result.all,
    Result.map((preferences) => ({ kind, missing: false, preferences })),
  )
}

const specificity = (kind: Kind, range: Preference, offer: Preference): number => {
  if (kind === 'mediaType') {
    const [type, subtype] = String.split(range.value, '/')
    const [offeredType, offeredSubtype] = String.split(offer.value, '/')
    if (type !== '*' && type !== offeredType) return -1
    if (subtype !== '*' && subtype !== offeredSubtype) return -1
    const parameters = Record.toEntries(range.parameters)
    if (!Array.every(parameters, ([key, value]) => Option.contains(value)(Record.get(offer.parameters, key)))) return -1
    return (type === '*' ? 0 : subtype === '*' ? 1 : 2) * 1000 + parameters.length
  }
  if (range.value === '*') return 0
  if (kind === 'language') {
    return offer.value === range.value || String.startsWith(`${range.value}-`)(offer.value)
      ? String.split(range.value, '-').length
      : -1
  }
  return range.value === offer.value ? 1 : -1
}

const effectiveQuality = (parsed: Parsed, offer: Preference): number => {
  if (parsed.missing) return 1
  const { kind } = parsed
  const best = Array.reduce(parsed.preferences, { rank: -1, quality: 0 }, (best, range) => {
    const rank = specificity(kind, range, offer)
    if (rank < 0 || rank < best.rank) return best
    return { rank, quality: rank === best.rank ? Number.min(best.quality, range.quality) : range.quality }
  })
  if (kind === 'encoding' && offer.value === 'identity' && best.rank < 1) {
    return best.rank === 0 && best.quality === 0 ? 0 : 1
  }
  return best.quality
}

/**
 * Select an original supports entry, or None, without an unconditional fallback.
 * Media ranges use most-specific matching range quality, including parameters and q=0.
 * Type/subtype, parameter names, charset values, language tags and coding names are
 * case-insensitive. Other media parameter values are case-sensitive.
 * Languages use RFC 4647 basic filtering, not lookup: `en` matches `en-US`, not vice versa.
 * Encoding identity has quality 1 unless explicit identity or `*;q=0` excludes it.
 * A positive encoding wildcard does not lower identity's implicit quality.
 * Equal-specificity duplicate matches use the lowest quality (fail closed).
 * Equal effective qualities use server supports order. Offers must be concrete and valid,
 * with at most 128 offers of at most 8192 characters each.
 */
export const negotiate = (
  kind: Kind,
  header: string | null | undefined,
  supports: ReadonlyArray<string>,
): Result.Result<Option.Option<string>, ParseError> =>
  Result.flatMap(parse(kind, header), (parsed) => {
    if (supports.length > 128) return invalid(kind, 'Too many offers')
    return pipe(
      supports,
      Iterable.map((supported) =>
        isBoundedAscii(supported)
          ? Result.map(parsePreference(kind, supported, true), (offer) => ({
              supported,
              quality: effectiveQuality(parsed, offer),
            }))
          : invalid(kind, 'Invalid or oversized offer'),
      ),
      Result.all,
      Result.map(
        (offers) =>
          Array.reduce(offers, { selected: Option.none<string>(), quality: 0 }, (best, { supported, quality }) =>
            quality > best.quality ? { selected: Option.some(supported), quality } : best,
          ).selected,
      ),
    )
  })

/** Negotiate directly from Web Headers, without middleware. */
export const negotiateHeaders = (kind: Kind, headers: Headers, supports: ReadonlyArray<string>) =>
  negotiate(kind, headers.get(names[kind]), supports)

/** Negotiate directly from a Web Request, without reading its body. */
export const negotiateRequest = (kind: Kind, request: Request, supports: ReadonlyArray<string>) =>
  negotiateHeaders(kind, request.headers, supports)

/** Obtain the current Effect server request, preserving explicit parse failures. */
export const negotiateEffect = (
  kind: Kind,
  supports: ReadonlyArray<string>,
): Effect.Effect<Option.Option<string>, ParseError, HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.fromResult(negotiate(kind, request.headers[names[kind]], supports)),
  )
