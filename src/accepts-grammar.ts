import { Array, Option, Schema, SchemaGetter, String, pipe } from 'effect'

const maximumHeaderLength = 8192
const maximumPreferences = 128
const maximumPreferenceParts = 129
const maximumOffers = 128
const firstQuotedContent = 1
const endBeforeClosingQuote = -1
const minimumQuality = 0
const maximumQuality = 1

const BoundedAscii = Schema.String.check(
  Schema.isMaxLength(maximumHeaderLength),
  Schema.isPattern(/^[\u0020-\u007E\t]*(?![\s\S])/u),
).pipe(Schema.brand('AcceptsBoundedAscii'))
const tokenCharacters = "!#$%&'+.^_`|~0-9A-Za-z-"
const concreteTokenPattern = `[${tokenCharacters}]+`
const Token = Schema.String.check(Schema.isPattern(new RegExp(`^[*${tokenCharacters}]+$`, 'u')))
const ParameterName = Token.pipe(Schema.brand('AcceptsParameterName'))
const Coding = Schema.String.check(Schema.isPattern(new RegExp(`^${concreteTokenPattern}$`, 'u'))).pipe(
  Schema.brand('AcceptsCoding'),
)
const Language = Schema.String.check(Schema.isPattern(/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u)).pipe(
  Schema.brand('AcceptsLanguage'),
)
const MediaType = Schema.String.check(
  Schema.isPattern(new RegExp(`^${concreteTokenPattern}/${concreteTokenPattern}$`, 'u')),
).pipe(Schema.brand('AcceptsMediaType'))
const MediaWildcard = Schema.String.check(Schema.isPattern(new RegExp(`^${concreteTokenPattern}/\\*$`, 'u'))).pipe(
  Schema.brand('AcceptsMediaWildcard'),
)
const MediaRange = Schema.Union([MediaType, Schema.Literal('*/*'), MediaWildcard])
const Wildcard = Schema.Literal('*')
const LanguageRange = Schema.Union([Language, Wildcard])
const CodingRange = Schema.Union([Coding, Wildcard])

const QuotedParameter = Schema.String.check(Schema.isPattern(/^"(?:[^"\\]|\\.)*"$/u))
const ParameterValue = BoundedAscii.pipe(Schema.brand('AcceptsParameterValue'))
const WireParameterValue = Schema.Union([Token, QuotedParameter]).pipe(
  Schema.decodeTo(ParameterValue, {
    decode: SchemaGetter.transform((value) =>
      String.startsWith('"')(value)
        ? pipe(
            value,
            String.slice(firstQuotedContent, endBeforeClosingQuote),
            String.replaceAll(/\\(?<escaped>.)/gu, '$<escaped>'),
          )
        : value,
    ),
    encode: SchemaGetter.transform((value) => `"${String.replaceAll(/["\\]/gu, globalThis.String.raw`\$&`)(value)}"`),
  }),
)
const Quality = Schema.Number.check(Schema.isBetween({ maximum: maximumQuality, minimum: minimumQuality })).pipe(
  Schema.brand('AcceptsQuality'),
)
const WireQuality = Schema.String.check(Schema.isPattern(/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u)).pipe(
  Schema.decodeTo(Schema.NumberFromString),
  Schema.decodeTo(Quality),
)
const decodeQuality = Schema.decodeUnknownOption(Quality)
export const fullQuality = Option.getOrThrow(decodeQuality(maximumQuality))
export const refusedQuality = Option.getOrThrow(decodeQuality(minimumQuality))

const PreferenceParts = Schema.NonEmptyArray(Schema.String).check(Schema.isMaxLength(maximumPreferenceParts))
const PreferenceMembers = Schema.Array(BoundedAscii).check(Schema.isMaxLength(maximumPreferences))
// Check the length without visiting entries before parsing offers in server order.
const OfferList = Schema.declare<Readonly<unknown[]>>(Array.isArray).check(Schema.isMaxLength(maximumOffers))

export const decodeBoundedAscii = Schema.decodeUnknownOption(BoundedAscii)
export const decodeParameterName = Schema.decodeUnknownOption(ParameterName)
export const decodeParameterValue = Schema.decodeUnknownOption(WireParameterValue)
export const decodeWireQuality = Schema.decodeUnknownOption(WireQuality)
export const decodePreferenceParts = Schema.decodeUnknownOption(PreferenceParts)
export const decodePreferenceMembers = Schema.decodeUnknownOption(PreferenceMembers)
export const decodeOfferList = Schema.decodeUnknownOption(OfferList)

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
}

export type HeaderText = typeof BoundedAscii.Type
export type ParameterKey = typeof ParameterName.Type
export type ParameterText = typeof ParameterValue.Type
export type QualityValue = typeof Quality.Type
export type PreferenceValue = typeof MediaRange.Type | typeof LanguageRange.Type | typeof CodingRange.Type

export const decodePreferenceValue = (
  kind: keyof typeof preferenceDecoders,
  offered: boolean,
  raw: string,
): Option.Option<PreferenceValue> => {
  const decoders = preferenceDecoders[kind]
  const decode = offered ? decoders.offer : decoders.range
  return decode(String.toLowerCase(raw))
}
