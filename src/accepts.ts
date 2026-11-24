import {
  Array,
  Data,
  Effect,
  Iterable,
  Option,
  Predicate,
  Record,
  Result,
  Schema,
  SchemaGetter,
  String,
  pipe,
} from 'effect'
import { HttpServerRequest } from 'effect/http'

/** The four independent HTTP preference grammars. */
export type Kind = 'mediaType' | 'language' | 'encoding' | 'charset'

export class ParseError extends Data.TaggedError('AcceptsParseError')<{
  readonly kind: Kind
  readonly reason: string
}> {}

export interface Preference {
  readonly value: typeof MediaRange.Type | typeof LanguageRange.Type | typeof CodingRange.Type
  readonly parameters: Readonly<Record<string, typeof ParameterValue.Type>>
  readonly quality: typeof Quality.Type
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

const BoundedAscii = Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^[\x20-\x7e\t]*(?![\s\S])/)).pipe(
  Schema.brand('AcceptsBoundedAscii'),
)
const tokenCharacters = "!#$%&'+.^_`|~0-9A-Za-z-"
const concreteTokenPattern = `[${tokenCharacters}]+`
const Token = Schema.String.check(Schema.isPattern(new RegExp(`^[*${tokenCharacters}]+$`)))
const ParameterName = Token.pipe(Schema.brand('AcceptsParameterName'))
const Coding = Schema.String.check(Schema.isPattern(new RegExp(`^${concreteTokenPattern}$`))).pipe(
  Schema.brand('AcceptsCoding'),
)
const Language = Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/)).pipe(
  Schema.brand('AcceptsLanguage'),
)
const MediaType = Schema.String.check(
  Schema.isPattern(new RegExp(`^${concreteTokenPattern}/${concreteTokenPattern}$`)),
).pipe(Schema.brand('AcceptsMediaType'))
const MediaWildcard = Schema.String.check(Schema.isPattern(new RegExp(`^${concreteTokenPattern}/\\*$`))).pipe(
  Schema.brand('AcceptsMediaWildcard'),
)
const MediaRange = Schema.Union([MediaType, Schema.Literal('*/*'), MediaWildcard])
const Wildcard = Schema.Literal('*')
const LanguageRange = Schema.Union([Language, Wildcard])
const CodingRange = Schema.Union([Coding, Wildcard])

const QuotedParameter = Schema.String.check(Schema.isPattern(/^"(?:[^"\\]|\\.)*"$/))
const ParameterValue = BoundedAscii.pipe(Schema.brand('AcceptsParameterValue'))
const WireParameterValue = Schema.Union([Token, QuotedParameter]).pipe(
  Schema.decodeTo(ParameterValue, {
    decode: SchemaGetter.transform((value) =>
      String.startsWith('"')(value) ? pipe(value, String.slice(1, -1), String.replaceAll(/\\(.)/g, '$1')) : value,
    ),
    encode: SchemaGetter.transform((value) => `"${String.replaceAll(/["\\]/g, '\\$&')(value)}"`),
  }),
)
const Quality = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.brand('AcceptsQuality'))
const WireQuality = Schema.String.check(Schema.isPattern(/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/)).pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(Quality),
)
const decodeQuality = Schema.decodeUnknownOption(Quality)
const fullQuality = Option.getOrThrow(decodeQuality(1))
const refusedQuality = Option.getOrThrow(decodeQuality(0))

const PreferenceParts = Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(129))
const PreferenceMembers = Schema.Array(BoundedAscii).check(Schema.isMaxLength(128))
// Check the length without visiting entries before parsing offers in server order.
const OfferList = Schema.declare<ReadonlyArray<unknown>>(Array.isArray).check(Schema.isMaxLength(128))

const decodeBoundedAscii = Schema.decodeUnknownOption(BoundedAscii)
const decodeParameterName = Schema.decodeUnknownOption(ParameterName)
const decodeParameterValue = Schema.decodeUnknownOption(WireParameterValue)
const decodeWireQuality = Schema.decodeUnknownOption(WireQuality)
const decodePreferenceParts = Schema.decodeUnknownOption(PreferenceParts)
const decodePreferenceMembers = Schema.decodeUnknownOption(PreferenceMembers)
const decodeOfferList = Schema.decodeUnknownOption(OfferList)

const decodeMediaType = Schema.decodeUnknownOption(MediaType)
const decodeMediaRange = Schema.decodeUnknownOption(MediaRange)
const decodeLanguage = Schema.decodeUnknownOption(Language)
const decodeLanguageRange = Schema.decodeUnknownOption(LanguageRange)
const decodeCoding = Schema.decodeUnknownOption(Coding)
const decodeCodingRange = Schema.decodeUnknownOption(CodingRange)

const preferenceDecoders = {
  charset: { offer: decodeCoding, range: decodeCodingRange },
  encoding: { offer: decodeCoding, range: decodeCodingRange },
  language: { offer: decodeLanguage, range: decodeLanguageRange },
  mediaType: { offer: decodeMediaType, range: decodeMediaRange },
} satisfies Record<Kind, unknown>

const invalid = (kind: Kind, reason: string): Result.Result<never, ParseError> =>
  Result.fail(new ParseError({ kind, reason }))

// Delimiters in quoted strings are data, not list or parameter separators.
const split = (input: typeof BoundedAscii.Type, delimiter: ',' | ';'): ReadonlyArray<string> | undefined => {
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

interface Parameters {
  readonly values: Readonly<Record<typeof ParameterName.Type, typeof ParameterValue.Type>>
  readonly quality: Option.Option<typeof Quality.Type>
}

const parseParameter = (
  kind: Kind,
  offered: boolean,
  parameters: Parameters,
  part: string,
): Result.Result<Parameters, ParseError> => {
  const equals = String.indexOf('=')(part)
  if (Option.isNone(equals) || equals.value < 1) {
    return invalid(kind, 'Invalid parameter')
  }
  const decodedName = pipe(part, String.slice(0, equals.value), String.trim, String.toLowerCase, decodeParameterName)
  const raw = pipe(part, String.slice(equals.value + 1), String.trim)
  if (Option.isNone(decodedName)) {
    return invalid(kind, 'Invalid parameter')
  }
  const name = decodedName.value
  if (name === 'q') {
    if (offered || Option.isSome(parameters.quality)) {
      return invalid(kind, 'Invalid quality')
    }
    const quality = decodeWireQuality(raw)
    if (Option.isNone(quality)) {
      return invalid(kind, 'Invalid quality')
    }
    return Result.succeed({ ...parameters, quality })
  }
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

const parsePreference = (
  kind: Kind,
  input: typeof BoundedAscii.Type,
  offered: boolean,
): Result.Result<Preference, ParseError> => {
  const parts = decodePreferenceParts(split(input, ';'))
  if (Option.isNone(parts)) {
    return invalid(kind, 'Invalid preference value')
  }
  const [rawValue, ...rawParameters] = parts.value
  const decoders = preferenceDecoders[kind]
  const decode = offered ? decoders.offer : decoders.range
  const value: Option.Option<Preference['value']> = decode(String.toLowerCase(rawValue))
  if (Option.isNone(value)) {
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
      value: value.value,
      parameters: values,
      quality: Option.getOrElse(quality, () => fullQuality),
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
  const members = decodePreferenceMembers(split(input.value, ','))
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

const specificity = (kind: Kind, range: Preference, offer: Preference): number => {
  if (kind === 'mediaType') {
    const [type, subtype] = String.split(range.value, '/')
    const [offeredType, offeredSubtype] = String.split(offer.value, '/')
    if (type !== '*' && type !== offeredType) {
      return -1
    }
    if (subtype !== '*' && subtype !== offeredSubtype) {
      return -1
    }
    const parameters = Record.toEntries(range.parameters)
    if (!Array.every(parameters, ([key, value]) => Option.contains(value)(Record.get(offer.parameters, key)))) {
      return -1
    }
    return (type === '*' ? 0 : subtype === '*' ? 1 : 2) * 1000 + parameters.length
  }
  if (range.value === '*') {
    return 0
  }
  if (kind === 'language') {
    return offer.value === range.value || String.startsWith(`${range.value}-`)(offer.value)
      ? String.split(range.value, '-').length
      : -1
  }
  return range.value === offer.value ? 1 : -1
}

const effectiveQuality = (parsed: Parsed, offer: Preference): typeof Quality.Type => {
  if (parsed.missing) {
    return fullQuality
  }
  const { kind } = parsed
  const best = Array.reduce(parsed.preferences, { rank: -1, quality: refusedQuality }, (best, range) => {
    const rank = specificity(kind, range, offer)
    if (rank < 0 || rank < best.rank) {
      return best
    }
    if (rank === best.rank && best.quality <= range.quality) {
      return best
    }
    return { rank, quality: range.quality }
  })
  if (kind === 'encoding' && offer.value === 'identity' && best.rank < 1) {
    return best.rank === 0 && best.quality === 0 ? refusedQuality : fullQuality
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
          supported: input.value,
          quality: effectiveQuality(parsed, offer),
        }))
      }),
      Result.all,
      Result.map(
        (offers) =>
          Array.reduce(
            offers,
            { selected: Option.none<string>(), quality: refusedQuality },
            (best, { supported, quality }) =>
              quality > best.quality ? { selected: Option.some(supported), quality } : best,
          ).selected,
      ),
    )
  })

/** Negotiate directly from Web Headers, without middleware. */
export const negotiateHeaders = (
  kind: Kind,
  headers: Headers,
  supports: ReadonlyArray<string>,
): Result.Result<Option.Option<string>, ParseError> => negotiate(kind, headers.get(names[kind]), supports)

/** Negotiate directly from a Web Request, without reading its body. */
export const negotiateRequest = (
  kind: Kind,
  request: Request,
  supports: ReadonlyArray<string>,
): Result.Result<Option.Option<string>, ParseError> => negotiateHeaders(kind, request.headers, supports)

/** Obtain the current Effect server request, preserving explicit parse failures. */
export const negotiateEffect = (
  kind: Kind,
  supports: ReadonlyArray<string>,
): Effect.Effect<Option.Option<string>, ParseError, HttpServerRequest.HttpServerRequest> =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Effect.fromResult(negotiate(kind, request.headers[names[kind]], supports)),
  )
