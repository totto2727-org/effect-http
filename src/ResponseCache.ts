import { Cache, Clock, Effect, Option } from 'effect'
import * as Cookies from 'effect/http/Cookies'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import * as CacheControl from './CacheControl.ts'

export interface Options {
  readonly capacity: number
  readonly ttlMilliseconds: number
  readonly maxBodyBytes: number
  readonly vary: ReadonlyArray<string>
  /** Caller guarantees output depends only on target, host and declared variants, never other headers or identity. */
  readonly publicRoute: true
}
interface Entry {
  readonly response: HttpServerResponse.HttpServerResponse
  readonly storedAt: number
  readonly expiresAt: number
  readonly initialAgeMilliseconds: number
}

const copy = (response: HttpServerResponse.HttpServerResponse): HttpServerResponse.HttpServerResponse =>
  response.body._tag === 'Uint8Array'
    ? HttpServerResponse.uint8Array(response.body.body.slice(), { status: response.status, headers: response.headers })
    : HttpServerResponse.empty({ status: response.status, headers: response.headers })

const blockedRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  const h = request.headers
  if (
    request.method !== 'GET' ||
    [
      'authorization',
      'cookie',
      'range',
      'if-range',
      'if-match',
      'if-none-match',
      'if-modified-since',
      'if-unmodified-since',
      'pragma',
    ].some((key) => h[key] !== undefined)
  )
    return true
  if (h['cache-control'] !== undefined) {
    const parsed = CacheControl.parse(h['cache-control'])
    if (parsed._tag === 'Invalid') return true
    // Request freshness constraints need revalidation, which this route cache deliberately does not implement.
    if (Object.keys(parsed.directives).length > 0) return true
  }
  return false
}

/** Explicit public GET route cache, not a proxy cache. Call invalidateAll after writes, including writes outside this route. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    if (
      options.publicRoute !== true ||
      !Number.isSafeInteger(options.capacity) ||
      options.capacity <= 0 ||
      !Number.isSafeInteger(options.maxBodyBytes) ||
      options.maxBodyBytes < 0 ||
      !Number.isFinite(options.ttlMilliseconds) ||
      options.ttlMilliseconds <= 0
    )
      throw new TypeError('Invalid route cache configuration')
    const vary = [...new Set(options.vary.map((name) => name.toLowerCase()))].sort()
    if (vary.some((name) => !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || ['authorization', 'cookie'].includes(name)))
      throw new TypeError('Invalid Vary declaration')
    const storage = yield* Cache.make<string, Entry>({
      capacity: options.capacity,
      timeToLive: options.ttlMilliseconds,
      lookup: () => Effect.die('Route cache uses explicit insertion only'),
    })
    let generation = 0
    const invalidateAll = Effect.uninterruptible(
      Effect.gen(function* () {
        generation++
        yield* Cache.invalidateAll(storage)
      }),
    )
    const middleware = <E, R>(
      handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<HttpServerResponse.HttpServerResponse, E, R | HttpServerRequest.HttpServerRequest> =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (blockedRequest(request)) return yield* handler
        const url = HttpServerRequest.toURL(request)
        if (Option.isNone(url)) return yield* handler
        const currentGeneration = generation
        const key = JSON.stringify([
          currentGeneration,
          request.method,
          request.originalUrl,
          url.value.href,
          request.headers['host'] ?? '',
          vary.map((name) => [name, request.headers[name] ?? null]),
        ])
        const now = yield* Clock.currentTimeMillis
        const cached = yield* Cache.getOption(storage, key)
        if (Option.isSome(cached) && generation === currentGeneration && now < cached.value.expiresAt) {
          return HttpServerResponse.setHeader(
            copy(cached.value.response),
            'age',
            String(Math.floor((Math.max(0, now - cached.value.storedAt) + cached.value.initialAgeMilliseconds) / 1000)),
          )
        }
        const response = yield* handler
        const body = response.body
        if (
          response.status !== 200 ||
          !Cookies.isEmpty(response.cookies) ||
          response.headers['set-cookie'] !== undefined ||
          response.headers['expires'] !== undefined ||
          (body._tag !== 'Empty' && body._tag !== 'Uint8Array') ||
          (body._tag === 'Uint8Array' && body.body.length > options.maxBodyBytes) ||
          response.headers['content-type']?.toLowerCase().startsWith('text/event-stream')
        )
          return response
        const varyHeader = response.headers['vary']
        if (varyHeader !== undefined && (varyHeader.length > 8192 || /[^\t\x20-\x7e]/.test(varyHeader))) return response
        const declared = varyHeader?.split(',').map((value) => value.trim().toLowerCase()) ?? []
        if (declared.length > 64 || declared.some((name) => name === '*' || !vary.includes(name))) return response
        const control = response.headers['cache-control']
        let lifetime = options.ttlMilliseconds
        if (control !== undefined) {
          const parsed = CacheControl.parse(control)
          if (
            parsed._tag === 'Invalid' ||
            parsed.directives.private ||
            parsed.directives.noStore ||
            parsed.directives.noCache
          )
            return response
          const seconds = parsed.directives.sMaxAge ?? parsed.directives.maxAge
          if (seconds !== undefined) lifetime = Math.min(lifetime, seconds * 1000)
        }
        const ageHeader = response.headers['age']
        if (ageHeader !== undefined && (ageHeader.length > 16 || !/^\d+$/.test(ageHeader))) return response
        const storedAt = yield* Clock.currentTimeMillis
        const ageSeconds = ageHeader === undefined ? 0 : Number(ageHeader)
        if (!Number.isSafeInteger(ageSeconds) || ageSeconds > Number.MAX_SAFE_INTEGER / 1000) return response
        // Corrected initial age retains subsecond apparent age and includes the origin response delay.
        let initialAgeMilliseconds = ageSeconds * 1000 + Math.max(0, storedAt - now)
        if (response.headers['date'] !== undefined) {
          if (response.headers['date'].length !== 29) return response
          const date = Date.parse(response.headers['date'])
          if (!Number.isFinite(date) || new Date(date).toUTCString() !== response.headers['date']) return response
          initialAgeMilliseconds = Math.max(initialAgeMilliseconds, Math.max(0, storedAt - date))
        }
        lifetime -= initialAgeMilliseconds
        if (lifetime <= 0) return response
        const expiresAt = storedAt + lifetime
        if (generation !== currentGeneration) return response
        const output = vary.length === 0 ? response : HttpServerResponse.setHeader(response, 'vary', vary.join(', '))
        yield* Cache.set(storage, key, { response: copy(output), storedAt, expiresAt, initialAgeMilliseconds })
        return output
      })
    return { middleware, invalidateAll }
  })
