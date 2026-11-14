import { Effect, Option, Result } from 'effect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'

/** The four independent HTTP preference grammars. */
export type Kind = 'mediaType' | 'language' | 'encoding' | 'charset'

export interface ParseError {
  readonly _tag: 'AcceptsParseError'
  readonly kind: Kind
  readonly reason: string
}

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
const invalid = (kind: Kind, reason: string): Result.Result<never, ParseError> =>
  Result.fail({ _tag: 'AcceptsParseError', kind, reason })

// Delimiters in quoted strings are data, not list or parameter separators.
const split = (input: string, delimiter: string): ReadonlyArray<string> | undefined => {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const character = input[i]
    if (escaped) escaped = false
    else if (quoted && character === '\\') escaped = true
    else if (character === '"') quoted = !quoted
    else if (!quoted && character === delimiter) {
      parts.push(input.slice(start, i).trim())
      start = i + 1
    }
  }
  if (quoted || escaped) return undefined
  parts.push(input.slice(start).trim())
  return parts
}

const parameterValue = (input: string): string | undefined => {
  if (token.test(input)) return input
  if (!input.startsWith('"') || !input.endsWith('"')) return undefined
  let value = ''
  for (let i = 1; i < input.length - 1; i++) {
    const character = input[i]
    if (character === '\\') {
      i++
      if (i >= input.length - 1) return undefined
      value += input[i]
    } else if (character === '"') return undefined
    else value += character
  }
  return value
}

const validValue = (kind: Kind, value: string, offered: boolean): boolean => {
  if (kind === 'mediaType') {
    const [type, subtype, extra] = value.split('/')
    return (
      type !== undefined &&
      subtype !== undefined &&
      extra === undefined &&
      token.test(type) &&
      token.test(subtype) &&
      (!type.includes('*') || type === '*') &&
      (!subtype.includes('*') || subtype === '*') &&
      (type !== '*' || subtype === '*') &&
      (!offered || (type !== '*' && subtype !== '*'))
    )
  }
  if (value === '*') return !offered
  return kind === 'language' ? language.test(value) : token.test(value) && !value.includes('*')
}

const parsePreference = (kind: Kind, input: string, offered: boolean): Result.Result<Preference, ParseError> => {
  const parts = split(input, ';')
  const value = parts?.[0]?.toLowerCase()
  if (parts === undefined || parts.length > 129 || value === undefined || !validValue(kind, value, offered)) {
    return invalid(kind, 'Invalid preference value')
  }
  const parameters: Record<string, string> = Object.create(null)
  let q = 1
  let seenQuality = false
  for (const part of parts.slice(1)) {
    const equals = part.indexOf('=')
    const name = part.slice(0, equals).trim().toLowerCase()
    const raw = part.slice(equals + 1).trim()
    if (equals < 1 || !token.test(name)) return invalid(kind, 'Invalid parameter')
    if (name === 'q') {
      if (offered || seenQuality || !quality.test(raw)) return invalid(kind, 'Invalid quality')
      seenQuality = true
      q = Number(raw)
    } else {
      // Accept extensions after q are deliberately rejected rather than silently ignored.
      if (kind !== 'mediaType' || seenQuality || Object.hasOwn(parameters, name)) {
        return invalid(kind, 'Unsupported or duplicate parameter')
      }
      const decoded = parameterValue(raw)
      if (decoded === undefined) return invalid(kind, 'Invalid parameter value')
      parameters[name] = name === 'charset' ? decoded.toLowerCase() : decoded
    }
  }
  return Result.succeed({ value, parameters, quality: q })
}

/**
 * Strict, bounded parsing: at most 8192 ASCII characters, 128 preferences and 128 parameters per preference.
 * Missing headers accept any offer. Empty headers accept none, except that encoding
 * still allows identity. Invalid syntax fails the entire header, never a permissive subset.
 * q must be an unquoted RFC quality with at most three decimals. Duplicate parameters,
 * empty list members, and Accept extensions after q are rejected.
 */
export const parse = (kind: Kind, header: string | null): Result.Result<Parsed, ParseError> => {
  if (header === null) return Result.succeed({ kind, missing: true, preferences: [] })
  if (header.length > 8192 || /[^\x20-\x7e\t]/.test(header)) return invalid(kind, 'Invalid or oversized header')
  if (header.trim() === '') return Result.succeed({ kind, missing: false, preferences: [] })
  const members = split(header, ',')
  if (members === undefined || members.length > 128) return invalid(kind, 'Invalid or excessive preference list')
  const preferences: Preference[] = []
  for (const member of members) {
    const parsed = parsePreference(kind, member, false)
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    preferences.push(parsed.success)
  }
  return Result.succeed({ kind, missing: false, preferences })
}

const specificity = (kind: Kind, range: Preference, offer: Preference): number => {
  if (kind === 'mediaType') {
    const [type, subtype] = range.value.split('/')
    const [offeredType, offeredSubtype] = offer.value.split('/')
    if (type !== '*' && type !== offeredType) return -1
    if (subtype !== '*' && subtype !== offeredSubtype) return -1
    const parameters = Object.entries(range.parameters)
    if (!parameters.every(([key, value]) => offer.parameters[key] === value)) return -1
    return (type === '*' ? 0 : subtype === '*' ? 1 : 2) * 1000 + parameters.length
  }
  if (range.value === '*') return 0
  if (kind === 'language') {
    return offer.value === range.value || offer.value.startsWith(`${range.value}-`) ? range.value.split('-').length : -1
  }
  return range.value === offer.value ? 1 : -1
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
  header: string | null,
  supports: ReadonlyArray<string>,
): Result.Result<Option.Option<string>, ParseError> => {
  const parsed = parse(kind, header)
  if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
  if (supports.length > 128) return invalid(kind, 'Too many offers')
  let selected: Option.Option<string> = Option.none()
  let best = 0
  for (const supported of supports) {
    if (supported.length > 8192 || /[^\x20-\x7e\t]/.test(supported)) return invalid(kind, 'Invalid or oversized offer')
    const offered = parsePreference(kind, supported, true)
    if (Result.isFailure(offered)) return Result.fail(offered.failure)
    let score = -1
    let q = parsed.success.missing ? 1 : 0
    for (const range of parsed.success.preferences) {
      const rank = specificity(kind, range, offered.success)
      if (rank < 0) continue
      if (rank > score) {
        score = rank
        q = range.quality
      } else if (rank === score) q = Math.min(q, range.quality)
    }
    if (kind === 'encoding' && offered.success.value === 'identity' && score < 1) {
      q = score === 0 && q === 0 ? 0 : 1
    }
    if (q > best) {
      best = q
      selected = Option.some(supported)
    }
  }
  return Result.succeed(selected)
}

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
    Effect.fromResult(negotiate(kind, request.headers[names[kind]] ?? null, supports)),
  )
