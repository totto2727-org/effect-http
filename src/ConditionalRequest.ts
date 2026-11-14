import { Effect } from 'effect'
import * as Digest from 'effect/crypto/Digest'
import * as Etag from 'effect/http/Etag'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

export const parseEtag = (value: string): Etag.Etag | undefined => {
  if (value.length > 8192) return undefined
  const match = /^(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/.exec(value)
  return match?.[0] !== value || match[2] === undefined
    ? undefined
    : { _tag: match[1] ? 'Weak' : 'Strong', value: match[2] }
}

export const matches = (left: Etag.Etag, right: Etag.Etag, strong = false): boolean =>
  left.value === right.value && (!strong || (left._tag === 'Strong' && right._tag === 'Strong'))

const listMatches = (value: string, tag: Etag.Etag | undefined, exists: boolean, strong: boolean): boolean => {
  if (value.length > 8192 || /[^\t\x20-\xff]|\x7f/.test(value)) return false
  const input = value.replace(/^[\t ]+|[\t ]+$/g, '')
  if (input === '*') return exists
  // Tokenize quoted opaque tags without splitting commas inside tags. Bound all scans and token counts.
  const token = /[\t ]*((?:W\/)?"[\x21\x23-\x7e\x80-\xff]*")[\t ]*(,|$)/y
  let offset = 0
  let count = 0
  let matched = false
  while (offset < input.length) {
    token.lastIndex = offset
    const item = token.exec(input)
    if (item?.[1] === undefined || ++count > 64) return false
    const candidate = parseEtag(item[1])
    if (candidate !== undefined && tag !== undefined && matches(candidate, tag, strong)) matched = true
    offset = token.lastIndex
    if (item[2] === ',' && offset === input.length) return false
  }
  return count > 0 && matched
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
const date = (value: string): number | undefined => {
  // Restrict to HTTP IMF-fixdate rather than accepting JavaScript's permissive date grammar.
  if (
    value.length !== 29 ||
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toUTCString() === value ? time : undefined
}

/** Evaluate write preconditions before running the write. Response middleware cannot protect side effects. */
export const evaluate = ({ method, headers, etag, lastModified, exists = true }: Evaluation): Decision => {
  const retrieval = method === 'GET' || method === 'HEAD'
  const modified = lastModified === undefined ? undefined : Math.floor(lastModified.getTime() / 1000) * 1000
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
  let output = response
  if (output.headers['etag'] === undefined && validators.etag !== undefined) {
    if (parseEtag(Etag.toString(validators.etag)) === undefined) throw new TypeError('Invalid ETag')
    output = HttpServerResponse.setHeader(output, 'etag', Etag.toString(validators.etag))
  }
  if (output.headers['last-modified'] === undefined && validators.lastModified !== undefined) {
    if (!Number.isFinite(validators.lastModified.getTime())) throw new TypeError('Invalid Last-Modified')
    output = HttpServerResponse.setHeader(output, 'last-modified', validators.lastModified.toUTCString())
  }
  if (response.status !== 200) return output
  const decision = evaluate({
    method: request.method,
    headers: request.headers,
    exists: validators.exists,
    etag: output.headers['etag'] === undefined ? undefined : parseEtag(output.headers['etag']),
    lastModified:
      output.headers['last-modified'] === undefined || date(output.headers['last-modified']) === undefined
        ? undefined
        : new Date(output.headers['last-modified']),
  })
  if (decision === 'Proceed') return output
  return HttpServerResponse.empty({
    status: decision === 'NotModified' ? 304 : 412,
    cookies: output.cookies,
    headers: Object.fromEntries(
      Object.entries(output.headers).filter(
        ([key]) =>
          !['content-length', 'content-type', 'transfer-encoding'].includes(key) &&
          (decision === 'NotModified' || key !== 'content-encoding'),
      ),
    ),
  })
}

/**
 * Registers final-response validation. Never reads streams, files, raw bodies or FormData, and never invents HEAD tags.
 * With Effect compression use app.pipe(middleware(options), HttpMiddleware.compression(options)).
 * Compression then runs first. Compressed streams require caller-supplied validators, preferably weak across encodings.
 */
export const middleware = (options: { readonly maxBodyBytes: number }) => {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 0) throw new TypeError('Invalid body limit')
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
          return apply(response, request, { etag: { _tag: 'Strong', value } })
        }),
      ),
    )
}
