import { Array, Data, DateTime, Effect, Option, Schema, String } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as Etag from 'effect/http/Etag'
import * as Headers from 'effect/http/Headers'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import * as HttpDate from './internal/HttpDate.ts'

export class ConfigError extends Data.TaggedError('ConditionalRequestConfigError')<{
  readonly message: string
}> {}

const Tags = Data.taggedEnum<Etag.Etag>()
const isBodyLimit = Schema.is(Schema.Natural)

export const parseEtag = (value: string): Etag.Etag | undefined => {
  if (String.length(value) > 8192) return undefined
  return String.match(/^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/)(value).pipe(
    Option.filter((match) => match[0] === value),
    Option.flatMap((match) =>
      Option.fromNullishOr(match[2]).pipe(
        Option.map((value) => (match[1] ? Tags.Weak({ value }) : Tags.Strong({ value }))),
      ),
    ),
    Option.getOrUndefined,
  )
}

export const matches = (left: Etag.Etag, right: Etag.Etag, strong = false): boolean =>
  left.value === right.value && (!strong || (left._tag === 'Strong' && right._tag === 'Strong'))

const listMatches = (value: string, tag: Etag.Etag | undefined, exists: boolean, strong: boolean): boolean => {
  if (String.length(value) > 8192 || Option.isSome(String.match(/[^\t\x20-\xff]|\x7f/)(value))) return false
  const input = String.replace(/^[\t ]+|[\t ]+$/g, '')(value)
  if (input === '*') return exists
  // Sticky matching stops at malformed input. Require complete coverage before accepting any tag.
  const items = Array.fromIterable(String.matchAll(/[\t ]*((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")[\t ]*(,|$)/gy)(input))
  const complete = Array.reduce(items, 0, (length, item) => length + String.length(item[0])) === String.length(input)
  return (
    items.length > 0 &&
    items.length <= 64 &&
    complete &&
    !String.endsWith(',')(input) &&
    Array.some(items, (item) => {
      const candidate = item[1] === undefined ? undefined : parseEtag(item[1])
      return candidate !== undefined && tag !== undefined && matches(candidate, tag, strong)
    })
  )
}

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
const date = (value: string): number | undefined =>
  HttpDate.parse(value).pipe(Option.map(DateTime.toEpochMillis), Option.getOrUndefined)

/** Evaluate write preconditions before running the write. Response middleware cannot protect side effects. */
export const evaluate = ({ method, headers, etag, lastModified, exists = true }: Evaluation): Decision => {
  const retrieval = method === 'GET' || method === 'HEAD'
  const modified = Option.fromNullishOr(lastModified).pipe(
    Option.flatMap(DateTime.make),
    Option.map((value) => DateTime.toEpochMillis(DateTime.startOf(value, 'second'))),
    Option.getOrUndefined,
  )
  const ifMatch = headers['if-match']
  if (ifMatch !== undefined && !listMatches(ifMatch, etag, exists, true)) return 'PreconditionFailed'
  const unmodified = headers['if-unmodified-since']
  if (ifMatch === undefined && unmodified !== undefined && modified !== undefined) {
    const limit = date(unmodified)
    if (limit !== undefined && modified > limit) return 'PreconditionFailed'
  }
  const none = headers['if-none-match']
  if (none !== undefined) {
    if (listMatches(none, etag, exists, false)) return retrieval ? 'NotModified' : 'PreconditionFailed'
  } else if (retrieval && modified !== undefined && headers['if-modified-since'] !== undefined) {
    const limit = date(headers['if-modified-since'])
    if (limit !== undefined && modified <= limit) return 'NotModified'
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
    response.headers['etag'] === undefined && validators.etag !== undefined ? Etag.toString(validators.etag) : undefined
  if (etag !== undefined && parseEtag(etag) === undefined) throw new ConfigError({ message: 'Invalid ETag' })
  const withEtag = etag === undefined ? response : HttpServerResponse.setHeader(response, 'etag', etag)
  const lastModified =
    response.headers['last-modified'] === undefined && validators.lastModified !== undefined
      ? DateTime.make(validators.lastModified).pipe(
          Option.map(Headers.formatHttpDate),
          Option.getOrThrowWith(() => new ConfigError({ message: 'Invalid Last-Modified' })),
        )
      : undefined
  const output =
    lastModified === undefined ? withEtag : HttpServerResponse.setHeader(withEtag, 'last-modified', lastModified)
  if (response.status !== 200) return output
  const decision = evaluate({
    method: request.method,
    headers: request.headers,
    exists: validators.exists,
    etag: output.headers['etag'] === undefined ? undefined : parseEtag(output.headers['etag']),
    lastModified: Option.fromNullishOr(output.headers['last-modified']).pipe(
      Option.flatMap(HttpDate.parse),
      Option.map(DateTime.toDateUtc),
      Option.getOrUndefined,
    ),
  })
  if (decision === 'Proceed') return output
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
  if (!isBodyLimit(options.maxBodyBytes)) throw new ConfigError({ message: 'Invalid body limit' })
  return <E, R>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest | Digest.Digest> =>
    Effect.flatMap(Digest.Digest, (digest) =>
      HttpEffect.withPreResponseHandler(handler, (request, response) =>
        Effect.gen(function* () {
          if (request.method !== 'GET' && request.method !== 'HEAD') return response
          if (request.method === 'HEAD' || response.headers['etag'] !== undefined) return apply(response, request)
          const body = response.body
          if (response.status !== 200 || (body._tag !== 'Empty' && body._tag !== 'Uint8Array'))
            return apply(response, request)
          const bytes = body._tag === 'Empty' ? new Uint8Array() : body.body
          if (bytes.length > options.maxBodyBytes) return apply(response, request)
          const value = yield* digest.digestHex(Digest.sha256, bytes)
          return apply(response, request, { etag: Tags.Strong({ value }) })
        }),
      ),
    )
}
