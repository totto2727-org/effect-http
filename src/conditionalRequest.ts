import { Array, Data, DateTime, Effect, Option, Predicate, Schema, String, pipe } from 'effect'
import { Digest } from 'effect/crypto'
import type { HttpServerRequest } from 'effect/http'
import { Etag, Headers, HttpEffect, HttpServerResponse } from 'effect/http'

import * as HttpDate from './internal/httpDate.ts'

export class ConfigError extends Data.TaggedError('ConditionalRequestConfigError')<{
  message: string
}> {}

const Tags = Data.taggedEnum<Etag.Etag>()
const BodyLimit = Schema.Natural.pipe(Schema.brand('ConditionalRequestBodyLimit'))
const decodeBodyLimit = Schema.decodeUnknownOption(BodyLimit)
const maximumEtagHeaderLength = 8192
const minimumEtagCount = 1
const maximumEtagCount = 64
const emptyParsedLength = 0
const okStatus = 200
const notModifiedStatus = 304
const preconditionFailedStatus = 412
const EtagHeaderLength = Schema.isMaxLength(maximumEtagHeaderLength)
// Use an absolute end assertion: `$` alone also matches before a final newline.
const EtagOpaqueValue = Schema.String.check(Schema.isPattern(/^[\u0021\u0023-\u007E\u0080-\u00FF]*(?![\s\S])/u)).pipe(
  Schema.brand('EtagOpaqueValue'),
)
const StrongTagWire = Schema.TemplateLiteralParser(['"', EtagOpaqueValue, '"'])
const WeakTagWire = Schema.TemplateLiteralParser(['W/"', EtagOpaqueValue, '"'])
const EtagWire = Schema.String.check(EtagHeaderLength).pipe(Schema.decodeTo(Schema.Union([StrongTagWire, WeakTagWire])))
type ParsedEtag = Readonly<Etag.Etag & { value: typeof EtagOpaqueValue.Type }>
const ParsedTags = Data.taggedEnum<ParsedEtag>()
const toEtag = ([prefix, value]: typeof EtagWire.Type): ParsedEtag =>
  prefix === 'W/"' ? ParsedTags.Weak({ value }) : ParsedTags.Strong({ value })
const decodeEtag = Schema.decodeUnknownOption(EtagWire)

export const parseEtag = (value: string): ParsedEtag | undefined =>
  decodeEtag(value).pipe(Option.map(toEtag), Option.getOrUndefined)

export const matches = (left: Etag.Etag, right: Etag.Etag, strong = false): boolean =>
  left.value === right.value && (!strong || (Tags.$is('Strong')(left) && Tags.$is('Strong')(right)))

const EtagListHeader = Schema.String.check(
  EtagHeaderLength,
  Schema.isPattern(/^[\t\u0020-\u007E\u0080-\u00FF]*(?![\s\S])/u),
).pipe(Schema.brand('EtagListHeader'))
const EtagList = Schema.Array(EtagWire)
  .check(Schema.isBetweenLength(minimumEtagCount, maximumEtagCount))
  .pipe(Schema.brand('EtagList'))
const decodeEtagListHeader = Schema.decodeUnknownOption(EtagListHeader)
const decodeEtagList = Schema.decodeUnknownOption(EtagList)

type TagComparison = Readonly<{
  exists: boolean
  strong: boolean
  tag: Etag.Etag | undefined
}>

const matchEtagList = (value: typeof EtagListHeader.Type, { exists, strong, tag }: TagComparison): boolean => {
  const input = String.replaceAll(/^[\t ]+|[\t ]+$/gu, '')(value)
  if (input === '*') {
    return exists
  }
  // Scan quoted tokens without validating their contents. Require complete coverage before comparing any tag.
  const items = Array.fromIterable(String.matchAll(/[\t ]*(?<tag>[^,"\t ]*"[^"]*")[\t ]*(?:,|$)/guy)(input))
  const complete =
    Array.reduce(items, emptyParsedLength, (length, item) => length + String.length(item[0])) === String.length(input)
  if (!complete || String.endsWith(',')(input) || Predicate.isNullish(tag)) {
    return false
  }
  return Option.exists(decodeEtagList(Array.map(items, (item) => item.groups?.['tag'])), (entries) =>
    Array.some(entries, (entry) => matches(toEtag(entry), tag, strong)),
  )
}

const listMatches = (value: string, comparison: TagComparison): boolean =>
  Option.exists(decodeEtagListHeader(value), (header) => matchEtagList(header, comparison))

/* oxlint-disable rules/no-readonly -- These exported interfaces preserve declaration merging and immutable inputs. */
export interface Validators {
  readonly etag?: Etag.Etag | undefined
  readonly lastModified?: Date | undefined
  readonly exists?: boolean | undefined
}
export interface Evaluation extends Validators {
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
}
/* oxlint-enable rules/no-readonly */
export type Decision = 'Proceed' | 'NotModified' | 'PreconditionFailed'

const compareDate = (
  value: string | undefined,
  modified: DateTime.Utc | undefined,
  compare: (left: DateTime.Utc, right: DateTime.Utc) => boolean,
): boolean =>
  Predicate.isNotNullish(value) &&
  Predicate.isNotNullish(modified) &&
  Option.exists(HttpDate.parse(value), (limit) => compare(modified, limit))

const evaluatePreconditions = (
  { method, headers, etag, exists = true }: Omit<Evaluation, 'lastModified'>,
  modified: DateTime.Utc | undefined,
): Decision => {
  const retrieval = method === 'GET' || method === 'HEAD'
  const ifMatch = headers['if-match']
  const matchesInitialCondition = Predicate.isNotNullish(ifMatch)
    ? listMatches(ifMatch, { exists, strong: true, tag: etag })
    : !compareDate(headers['if-unmodified-since'], modified, DateTime.isGreaterThan)
  if (!matchesInitialCondition) {
    return 'PreconditionFailed'
  }

  const none = headers['if-none-match']
  if (Predicate.isNotNullish(none) && listMatches(none, { exists, strong: false, tag: etag })) {
    return retrieval ? 'NotModified' : 'PreconditionFailed'
  }

  return Predicate.isNullish(none) &&
    retrieval &&
    compareDate(headers['if-modified-since'], modified, DateTime.isLessThanOrEqualTo)
    ? 'NotModified'
    : 'Proceed'
}

const normalizeModified = (value: Date | undefined): DateTime.Utc | undefined =>
  Option.fromNullishOr(value).pipe(
    Option.flatMap(DateTime.make),
    Option.map(DateTime.startOf('second')),
    Option.getOrUndefined,
  )

/**
 * Evaluate write preconditions before running an operation with side effects.
 * @param {Evaluation} evaluation - The method, conditional fields, and current representation validators.
 * @returns {Decision} Whether the request can proceed or must return a conditional response.
 */
export const evaluate = ({ lastModified, ...input }: Evaluation): Decision =>
  evaluatePreconditions(input, normalizeModified(lastModified))

const applyLastModified = (
  response: HttpServerResponse.HttpServerResponse,
  validators: Validators,
): HttpServerResponse.HttpServerResponse => {
  if (Predicate.isNotNullish(response.headers['last-modified']) || Predicate.isNullish(validators.lastModified)) {
    return response
  }
  const value = DateTime.make(validators.lastModified).pipe(
    Option.map(Headers.formatHttpDate),
    Option.getOrThrowWith(() => new ConfigError({ message: 'Invalid Last-Modified' })),
  )
  return HttpServerResponse.setHeader(response, 'last-modified', value)
}

/**
 * Apply validators to the selected representation. Existing response validators take precedence.
 * @param {HttpServerResponse.HttpServerResponse} response - The selected response.
 * @param {Pick<HttpServerRequest.HttpServerRequest, 'method' | 'headers'>} request - The conditional request.
 * @param {Validators} validators - Additional validators to attach when missing.
 * @returns {HttpServerResponse.HttpServerResponse} The response selected by the request preconditions.
 */
export const apply = (
  response: HttpServerResponse.HttpServerResponse,
  request: Pick<HttpServerRequest.HttpServerRequest, 'method' | 'headers'>,
  validators: Validators = {},
): HttpServerResponse.HttpServerResponse => {
  const etag =
    Predicate.isNullish(response.headers['etag']) && Predicate.isNotNullish(validators.etag)
      ? Etag.toString(validators.etag)
      : undefined
  const configuredEtag = Option.fromNullishOr(etag).pipe(
    Option.map((value) =>
      decodeEtag(value).pipe(
        Option.map(toEtag),
        Option.getOrThrowWith(() => new ConfigError({ message: 'Invalid ETag' })),
      ),
    ),
  )
  const withEtag = Predicate.isNullish(etag) ? response : HttpServerResponse.setHeader(response, 'etag', etag)
  const output = applyLastModified(withEtag, validators)
  if (response.status !== okStatus) {
    return output
  }
  const decision = evaluatePreconditions(
    {
      etag: Option.getOrElse(configuredEtag, () =>
        pipe(output.headers['etag'], Option.fromNullishOr, Option.map(parseEtag), Option.getOrUndefined),
      ),
      exists: validators.exists,
      headers: request.headers,
      method: request.method,
    },
    Option.fromNullishOr(output.headers['last-modified']).pipe(Option.flatMap(HttpDate.parse), Option.getOrUndefined),
  )
  if (decision === 'Proceed') {
    return output
  }
  return HttpServerResponse.empty({
    cookies: output.cookies,
    headers: Headers.removeMany(
      output.headers,
      decision === 'NotModified'
        ? ['content-length', 'content-type', 'transfer-encoding']
        : ['content-length', 'content-type', 'transfer-encoding', 'content-encoding'],
    ),
    status: decision === 'NotModified' ? notModifiedStatus : preconditionFailedStatus,
  })
}

const digestibleBody = (
  response: HttpServerResponse.HttpServerResponse,
  maxBodyBytes: typeof BodyLimit.Type,
): Option.Option<Uint8Array> => {
  const { body, status } = response
  if (status !== okStatus || (!Predicate.isTagged(body, 'Empty') && !Predicate.isTagged(body, 'Uint8Array'))) {
    return Option.none()
  }
  const bytes = Predicate.isTagged(body, 'Empty') ? new Uint8Array() : body.body
  return bytes.length > maxBodyBytes ? Option.none() : Option.some(bytes)
}

/**
 * Register final-response validation for bounded GET responses.
 * Register this middleware before Effect compression so compressed streams require caller-supplied validators.
 * @param {Readonly<{ maxBodyBytes: number }>} options - Maximum size of bodies eligible for automatic ETags.
 * @returns {HttpEffect.withPreResponseHandler} Middleware requiring the current request and a digest service.
 */
export const middleware = (options: Readonly<{ maxBodyBytes: number }>) => {
  const maxBodyBytes = decodeBodyLimit(options.maxBodyBytes).pipe(
    Option.getOrThrowWith(() => new ConfigError({ message: 'Invalid body limit' })),
  )
  return <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest | Digest.Digest> =>
    Effect.flatMap(Digest.Digest, (digest) =>
      HttpEffect.withPreResponseHandler(handler, (request, response) =>
        Effect.gen(function* () {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return response
          }
          if (request.method === 'HEAD' || Predicate.isNotNullish(response.headers['etag'])) {
            return apply(response, request)
          }
          const bytes = digestibleBody(response, maxBodyBytes)
          if (Option.isNone(bytes)) {
            return apply(response, request)
          }
          const value = yield* digest.digestHex(Digest.sha256, bytes.value)
          return apply(response, request, { etag: Tags.Strong({ value }) })
        }),
      ),
    )
}
