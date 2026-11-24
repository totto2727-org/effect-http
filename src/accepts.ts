import { Array, Data, Effect, Iterable, Option, Predicate, Record, Result, String, pipe } from 'effect'
import { HttpServerRequest } from 'effect/http'

import type { HeaderText, ParameterKey, ParameterText, PreferenceValue, QualityValue } from './acceptsGrammar.ts'
import {
  decodeBoundedAscii,
  decodeOfferList,
  decodeParameterName,
  decodeParameterValue,
  decodePreferenceMembers,
  decodePreferenceParts,
  decodePreferenceValue,
  decodeWireQuality,
  fullQuality,
  refusedQuality,
} from './acceptsGrammar.ts'
import { effectiveQuality } from './acceptsQuality.ts'

/** The four independent HTTP preference grammars. */
export type Kind = 'mediaType' | 'language' | 'encoding' | 'charset'

export class ParseError extends Data.TaggedError('AcceptsParseError')<{
  kind: Kind
  reason: string
}> {}

/* oxlint-disable rules/no-readonly -- These exported interfaces preserve declaration merging and immutable parser results. */
export interface Preference {
  readonly value: PreferenceValue
  readonly parameters: Readonly<Record<string, ParameterText>>
  readonly quality: QualityValue
}

export interface Parsed {
  readonly kind: Kind
  readonly missing: boolean
  readonly preferences: readonly Preference[]
}
/* oxlint-enable rules/no-readonly */

const names = {
  charset: 'accept-charset',
  encoding: 'accept-encoding',
  language: 'accept-language',
  mediaType: 'accept',
} satisfies Record<Kind, string>

const invalid = (kind: Kind, reason: string): Result.Result<never, ParseError> =>
  Result.fail(new ParseError({ kind, reason }))

const beforeFirstCharacter = -1
const firstCharacter = 0
const separatorWidth = 1

// Delimiters in quoted strings are data, not list or parameter separators.
const split = (input: HeaderText, delimiter: ',' | ';'): Readonly<string[]> | undefined => {
  // The optional closing quote lets the scan report an unterminated string instead of skipping it.
  const markers = Array.fromIterable(String.matchAll(/"(?:[^"\\]|\\.)*(?<closing>")?|[;,]/gu)(input))
  if (
    Array.some(
      markers,
      (match) => String.startsWith('"')(match[firstCharacter]) && Predicate.isNullish(match.groups?.['closing']),
    )
  ) {
    return undefined
  }
  const separators = Array.filterMap(markers, ({ [firstCharacter]: marker, index }) =>
    marker === delimiter && Predicate.isNotNullish(index) ? Result.succeed(index) : Result.failVoid,
  )
  return Array.zipWith(
    Array.prepend(separators, beforeFirstCharacter),
    Array.append(separators, input.length),
    (left, right) => pipe(input, String.slice(left + separatorWidth, right), String.trim),
  )
}

type Parameters = Readonly<{
  quality: Option.Option<QualityValue>
  values: Readonly<Record<ParameterKey, ParameterText>>
}>
type PreferenceContext = Readonly<{ kind: Kind; offered: boolean }>

const emptyParameters: Result.Result<Parameters, ParseError> = Result.succeed({
  quality: Option.none(),
  values: Record.empty(),
})

const nameAndValue = (part: string): Option.Option<Readonly<{ name: ParameterKey; raw: string }>> =>
  Option.gen(function* () {
    const equals = yield* String.indexOf('=')(part)
    if (equals <= firstCharacter) {
      return yield* Option.none()
    }
    const name = yield* pipe(
      part,
      String.slice(firstCharacter, equals),
      String.trim,
      String.toLowerCase,
      decodeParameterName,
    )
    const raw = pipe(part, String.slice(equals + separatorWidth), String.trim)
    return { name, raw }
  })

const parseQuality = (
  { kind, offered }: PreferenceContext,
  parameters: Parameters,
  raw: string,
): Result.Result<Parameters, ParseError> => {
  if (offered || Option.isSome(parameters.quality)) {
    return invalid(kind, 'Invalid quality')
  }
  const quality = decodeWireQuality(raw)
  return Option.isNone(quality) ? invalid(kind, 'Invalid quality') : Result.succeed({ ...parameters, quality })
}

const parseOrdinaryParameter = (
  kind: Kind,
  parameters: Parameters,
  { name, raw }: Readonly<{ name: ParameterKey; raw: string }>,
): Result.Result<Parameters, ParseError> => {
  // Accept extensions after q are deliberately rejected rather than silently ignored.
  if (kind !== 'mediaType' || Option.isSome(parameters.quality) || Record.has(parameters.values, name)) {
    return invalid(kind, 'Unsupported or duplicate parameter')
  }
  const decoded = decodeParameterValue(name === 'charset' ? String.toLowerCase(raw) : raw)
  if (Option.isNone(decoded)) {
    return invalid(kind, 'Invalid parameter value')
  }
  return Result.succeed({
    ...parameters,
    values: Record.set(parameters.values, name, decoded.value),
  })
}

const parseParameter = (
  context: PreferenceContext,
  parameters: Parameters,
  part: string,
): Result.Result<Parameters, ParseError> => {
  const parameter = nameAndValue(part)
  if (Option.isNone(parameter)) {
    return invalid(context.kind, 'Invalid parameter')
  }
  const { name, raw } = parameter.value
  return name === 'q'
    ? parseQuality(context, parameters, raw)
    : parseOrdinaryParameter(context.kind, parameters, parameter.value)
}

const parsePreference = (kind: Kind, input: HeaderText, offered: boolean): Result.Result<Preference, ParseError> => {
  const parts = decodePreferenceParts(split(input, ';'))
  if (Option.isNone(parts)) {
    return invalid(kind, 'Invalid preference value')
  }
  const [rawValue, ...rawParameters] = parts.value
  const value = decodePreferenceValue(kind, offered, rawValue)
  if (Option.isNone(value)) {
    return invalid(kind, 'Invalid preference value')
  }
  const context = { kind, offered }
  const parsedParameters = Array.reduce(rawParameters, emptyParameters, (state, part) =>
    Result.flatMap(state, (parameters) => parseParameter(context, parameters, part)),
  )
  return Result.map(parsedParameters, ({ values, quality }) => ({
    parameters: values,
    quality: Option.getOrElse(quality, () => fullQuality),
    value: value.value,
  }))
}

const parseMembers = (kind: Kind, input: HeaderText): Result.Result<Parsed, ParseError> => {
  const members = decodePreferenceMembers(split(input, ','))
  if (Option.isNone(members)) {
    return invalid(kind, 'Invalid or excessive preference list')
  }
  return pipe(
    members.value,
    Iterable.map((member) => parsePreference(kind, member, false)),
    Result.all,
    Result.map((preferences) => ({ kind, missing: false, preferences })),
  )
}

/**
 * Strict, bounded parsing: at most 8192 ASCII characters, 128 preferences and 128 parameters per preference.
 * Missing headers accept any offer. Empty headers accept none, except that encoding
 * still allows identity. Invalid syntax fails the entire header, never a permissive subset.
 * q must be an unquoted RFC quality with at most three decimals. Duplicate parameters,
 * empty list members, and Accept extensions after q are rejected.
 * @param {Kind} kind - The preference grammar to apply.
 * @param {string | null | undefined} header - The selected request field.
 * @returns {Result.Result<Parsed, ParseError>} Validated preferences or a parsing error.
 */
export const parse = (kind: Kind, header: string | null | undefined): Result.Result<Parsed, ParseError> => {
  if (Predicate.isNullish(header)) {
    return Result.succeed({ kind, missing: true, preferences: [] })
  }
  const input = decodeBoundedAscii(header)
  if (Option.isNone(input)) {
    return invalid(kind, 'Invalid or oversized header')
  }
  if (String.isEmpty(String.trim(input.value))) {
    return Result.succeed({ kind, missing: false, preferences: [] })
  }
  return parseMembers(kind, input.value)
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
 * @param {Kind} kind - The preference grammar to apply.
 * @param {string | null | undefined} header - The selected request field.
 * @param {Readonly<string[]>} supports - Server offers in preference order.
 * @returns {Result.Result<Option.Option<string>, ParseError>} The selected original offer, an empty result, or a parsing error.
 */
export const negotiate = (
  kind: Kind,
  header: string | null | undefined,
  supports: Readonly<string[]>,
): Result.Result<Option.Option<string>, ParseError> =>
  Result.flatMap(parse(kind, header), (parsed) => {
    const allowedOffers = decodeOfferList(supports)
    if (Option.isNone(allowedOffers)) {
      return invalid(kind, 'Too many offers')
    }
    return pipe(
      allowedOffers.value,
      Iterable.map((supported) => {
        const input = decodeBoundedAscii(supported)
        if (Option.isNone(input)) {
          return invalid(kind, 'Invalid or oversized offer')
        }
        return Result.map(parsePreference(kind, input.value, true), (offer) => ({
          quality: effectiveQuality(parsed, offer),
          supported: input.value,
        }))
      }),
      Result.all,
      Result.map(
        (offers) =>
          Array.reduce(
            offers,
            { quality: refusedQuality, selected: Option.none<string>() },
            (best, { supported, quality }) =>
              quality > best.quality ? { quality, selected: Option.some(supported) } : best,
          ).selected,
      ),
    )
  })

/**
 * Negotiate directly from Web Headers, without middleware.
 * @param {Kind} kind - The preference grammar to apply.
 * @param {Headers} headers - The request headers.
 * @param {Readonly<string[]>} supports - Server offers in preference order.
 * @returns {Result.Result<Option.Option<string>, ParseError>} The negotiation outcome for the request.
 */
export const negotiateHeaders = (
  kind: Kind,
  headers: Headers,
  supports: Readonly<string[]>,
): Result.Result<Option.Option<string>, ParseError> => negotiate(kind, headers.get(names[kind]), supports)

/**
 * Negotiate directly from a Web Request, without reading its body.
 * @param {Kind} kind - The preference grammar to apply.
 * @param {Request} request - The request whose headers are inspected.
 * @param {Readonly<string[]>} supports - Server offers in preference order.
 * @returns {Result.Result<Option.Option<string>, ParseError>} The negotiation outcome for the request.
 */
export const negotiateRequest = (
  kind: Kind,
  request: Request,
  supports: Readonly<string[]>,
): Result.Result<Option.Option<string>, ParseError> => negotiateHeaders(kind, request.headers, supports)

/**
 * Obtain the current Effect server request, preserving explicit parse failures.
 * @param {Kind} kind - The preference grammar to apply.
 * @param {Readonly<string[]>} supports - Server offers in preference order.
 * @returns {Effect.Effect<Option.Option<string>, ParseError, HttpServerRequest.HttpServerRequest>} The negotiation outcome for the request.
 */
export const negotiateEffect = (
  kind: Kind,
  supports: Readonly<string[]>,
): Effect.Effect<Option.Option<string>, ParseError, HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.fromResult(negotiate(kind, request.headers[names[kind]], supports)),
  )
