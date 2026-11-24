import { Array, Data, DateTime, Effect, Option, Predicate, Schema, String } from 'effect'
import { Digest } from 'effect/crypto'
import { Etag, Headers, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'

import * as HttpDate from './internal/httpDate.ts'

export class ConfigError extends Data.TaggedError('ConditionalRequestConfigError')<{
  readonly message: string
}> {}

const Tags = Data.taggedEnum<Etag.Etag>()
const BodyLimit = Schema.Natural.pipe(Schema.brand('ConditionalRequestBodyLimit'))
const decodeBodyLimit = Schema.decodeUnknownOption(BodyLimit)
const EtagHeaderLength = Schema.isMaxLength(8192)
// Use an absolute end assertion: `$` alone also matches before a final newline.
const EtagOpaqueValue = Schema.String.check(Schema.isPattern(/^[\x21\x23-\x7e\x80-\xff]*(?![\s\S])/)).pipe(
  Schema.brand('EtagOpaqueValue'),
)
const EtagWire = Schema.String.check(EtagHeaderLength).pipe(
  Schema.decodeTo(
    Schema.Union([
      Schema.TemplateLiteralParser(['"', EtagOpaqueValue, '"']),
      Schema.TemplateLiteralParser(['W/"', EtagOpaqueValue, '"']),
    ]),
  ),
)
type ParsedEtag = Readonly<Etag.Etag & { readonly value: typeof EtagOpaqueValue.Type }>
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
  Schema.isPattern(/^[\t\x20-\x7e\x80-\xff]*(?![\s\S])/),
).pipe(Schema.brand('EtagListHeader'))
const EtagList = Schema.Array(EtagWire).check(Schema.isBetweenLength(1, 64)).pipe(Schema.brand('EtagList'))
const decodeEtagListHeader = Schema.decodeUnknownOption(EtagListHeader)
const decodeEtagList = Schema.decodeUnknownOption(EtagList)

const matchEtagList = (
  value: typeof EtagListHeader.Type,
  tag: Etag.Etag | undefined,
  exists: boolean,
  strong: boolean,
): boolean => {
  const input = String.replace(/^[\t ]+|[\t ]+$/g, '')(value)
  if (input === '*') {
    return exists
  }
  // Scan quoted tokens without validating their contents. Require complete coverage before comparing any tag.
  const items = Array.fromIterable(String.matchAll(/[\t ]*([^,"\t ]*"[^"]*")[\t ]*(,|$)/gy)(input))
  const complete = Array.reduce(items, 0, (length, item) => length + String.length(item[0])) === String.length(input)
  if (!complete || String.endsWith(',')(input) || Predicate.isNullish(tag)) {
    return false
  }
  return Option.exists(decodeEtagList(Array.map(items, (item) => item[1])), (entries) =>
    Array.some(entries, (entry) => matches(toEtag(entry), tag, strong)),
  )
}

const listMatches = (value: string, tag: Etag.Etag | undefined, exists: boolean, strong: boolean): boolean =>
  Option.exists(decodeEtagListHeader(value), (header) => matchEtagList(header, tag, exists, strong))

export interface Validators {
  readonly etag?: Etag.Etag | undefined
  readonly lastModified?: Date | undefined
  readonly exists?: boolean | undefined
}
export interface Evaluation extends Validators {
  readonly method: string
  readonly headers: Readonly<Record<string, string | undefined>>
}
export type Decision = 'Proceed' | 'NotModified' | 'PreconditionFailed'

/** Evaluate write preconditions before running the write. Response middleware cannot protect side effects. */
export const evaluate = ({ lastModified, ...input }: Evaluation): Decision =>
  evaluatePreconditions(
    input,
    Option.fromNullishOr(lastModified).pipe(
      Option.flatMap(DateTime.make),
      Option.map(DateTime.startOf('second')),
      Option.getOrUndefined,
    ),
  )

const evaluatePreconditions = (
  { method, headers, etag, exists = true }: Omit<Evaluation, 'lastModified'>,
  modified: DateTime.Utc | undefined,
): Decision => {
  const retrieval = method === 'GET' || method === 'HEAD'
  const ifMatch = headers['if-match']
  if (Predicate.isNotNullish(ifMatch) && !listMatches(ifMatch, etag, exists, true)) {
    return 'PreconditionFailed'
  }
  const unmodified = headers['if-unmodified-since']
  if (Predicate.isNullish(ifMatch) && Predicate.isNotNullish(unmodified) && Predicate.isNotNullish(modified)) {
    if (Option.exists(HttpDate.parse(unmodified), (limit) => DateTime.isGreaterThan(modified, limit))) {
      return 'PreconditionFailed'
    }
  }
  const none = headers['if-none-match']
  if (Predicate.isNotNullish(none)) {
    if (listMatches(none, etag, exists, false)) {
      return retrieval ? 'NotModified' : 'PreconditionFailed'
    }
  } else if (retrieval && Predicate.isNotNullish(modified) && Predicate.isNotNullish(headers['if-modified-since'])) {
    if (
      Option.exists(HttpDate.parse(headers['if-modified-since']), (limit) =>
        DateTime.isLessThanOrEqualTo(modified, limit),
      )
    ) {
      return 'NotModified'
    }
  }
  return 'Proceed'
}

/** Apply validators to a selected representation. Existing response validators take precedence. */
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
  const lastModified =
    Predicate.isNullish(response.headers['last-modified']) && Predicate.isNotNullish(validators.lastModified)
      ? DateTime.make(validators.lastModified).pipe(
          Option.map(Headers.formatHttpDate),
          Option.getOrThrowWith(() => new ConfigError({ message: 'Invalid Last-Modified' })),
        )
      : undefined
  const output = Predicate.isNullish(lastModified)
    ? withEtag
    : HttpServerResponse.setHeader(withEtag, 'last-modified', lastModified)
  if (response.status !== 200) {
    return output
  }
  const decision = evaluatePreconditions(
    {
      method: request.method,
      headers: request.headers,
      exists: validators.exists,
      etag: Option.getOrElse(configuredEtag, () =>
        Option.fromNullishOr(output.headers['etag']).pipe(
          Option.flatMap(decodeEtag),
          Option.map(toEtag),
          Option.getOrUndefined,
        ),
      ),
    },
    Option.fromNullishOr(output.headers['last-modified']).pipe(Option.flatMap(HttpDate.parse), Option.getOrUndefined),
  )
  if (decision === 'Proceed') {
    return output
  }
  return HttpServerResponse.empty({
    status: decision === 'NotModified' ? 304 : 412,
    cookies: output.cookies,
    headers: Headers.removeMany(
      output.headers,
      decision === 'NotModified'
        ? ['content-length', 'content-type', 'transfer-encoding']
        : ['content-length', 'content-type', 'transfer-encoding', 'content-encoding'],
    ),
  })
}

/**
 * Registers final-response validation. Never reads streams, files, raw bodies or FormData, and never invents HEAD tags.
 * With Effect compression use app.pipe(middleware(options), HttpMiddleware.compression(options)).
 * Compression then runs first. Compressed streams require caller-supplied validators, preferably weak across encodings.
 */
export const middleware = (options: { readonly maxBodyBytes: number }) => {
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
          const body = response.body
          if (response.status !== 200 || (body._tag !== 'Empty' && body._tag !== 'Uint8Array')) {
            return apply(response, request)
          }
          const bytes = body._tag === 'Empty' ? new Uint8Array() : body.body
          if (bytes.length > maxBodyBytes) {
            return apply(response, request)
          }
          const value = yield* digest.digestHex(Digest.sha256, bytes)
          return apply(response, request, { etag: Tags.Strong({ value }) })
        }),
      ),
    )
}
