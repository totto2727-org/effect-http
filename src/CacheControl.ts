import { Effect } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

export interface Directives {
  readonly public?: boolean
  readonly private?: boolean
  readonly noCache?: boolean
  readonly noStore?: boolean
  readonly mustRevalidate?: boolean
  readonly proxyRevalidate?: boolean
  readonly immutable?: boolean
  readonly noTransform?: boolean
  readonly onlyIfCached?: boolean
  readonly maxAge?: number
  readonly sMaxAge?: number
  readonly minFresh?: number
  readonly maxStale?: number | true
}

export type ParseResult =
  | { readonly _tag: 'Success'; readonly directives: Directives }
  | { readonly _tag: 'Invalid'; readonly reason: string }

const flags = {
  public: 'public',
  private: 'private',
  'no-cache': 'noCache',
  'no-store': 'noStore',
  'must-revalidate': 'mustRevalidate',
  'proxy-revalidate': 'proxyRevalidate',
  immutable: 'immutable',
  'no-transform': 'noTransform',
  'only-if-cached': 'onlyIfCached',
} as const
const seconds = { 'max-age': 'maxAge', 's-maxage': 'sMaxAge', 'min-fresh': 'minFresh' } as const
const invalid = (reason: string): ParseResult => ({ _tag: 'Invalid', reason })

/** Unknown extensions and duplicates are rejected. Input is limited to 8192 code units and 64 directives. */
export const parse = (input: string): ParseResult => {
  if (input.length > 8192 || /[^\t\x20-\x7e]/.test(input)) return invalid('Invalid header bytes or length')
  const parts = input.split(',')
  if (parts.length > 64) return invalid('Too many directives')
  const directives: { -readonly [K in keyof Directives]?: Directives[K] } = {}
  const seen = new Set<string>()
  if (input.trim() === '') return invalid('Empty Cache-Control')
  for (const part of parts) {
    const match = /^[\t ]*([!#$%&'*+.^_`|~\w-]+)(?:[\t ]*=[\t ]*(\d+|"\d+"))?[\t ]*$/.exec(part)
    if (!match?.[1]) return invalid('Malformed directive')
    const name = match[1].toLowerCase()
    const value = match[2]
    if (seen.has(name)) return invalid(`Duplicate ${name}`)
    seen.add(name)
    if (Object.hasOwn(flags, name)) {
      if (value !== undefined) return invalid(`Unexpected value for ${name}`)
      const key = flags[name as keyof typeof flags]
      directives[key] = true
    } else if (Object.hasOwn(seconds, name) || name === 'max-stale') {
      if (name === 'max-stale' && value === undefined) directives.maxStale = true
      else {
        if (value === undefined) return invalid(`Missing value for ${name}`)
        const number = Number(value.replaceAll('"', ''))
        if (!Number.isSafeInteger(number) || number < 0) return invalid('Invalid seconds')
        if (name === 'max-stale') directives.maxStale = number
        else directives[seconds[name as keyof typeof seconds]] = number
      }
    } else return invalid(`Unsupported directive ${name}`)
  }
  if (directives.public && directives.private) return invalid('Conflicting visibility')
  return { _tag: 'Success', directives }
}

/** Throws on invalid application configuration rather than emitting a permissive policy. */
export const format = (directives: Directives): string => {
  const parts: string[] = []
  for (const [wire, key] of Object.entries(flags)) if (directives[key]) parts.push(wire)
  for (const [wire, key] of Object.entries(seconds)) {
    const value = directives[key]
    if (value !== undefined) parts.push(`${wire}=${value}`)
  }
  if (directives.maxStale !== undefined)
    parts.push(directives.maxStale === true ? 'max-stale' : `max-stale=${directives.maxStale}`)
  const value = parts.join(', ')
  if (parse(value)._tag === 'Invalid') throw new TypeError('Invalid Cache-Control configuration')
  return value
}

export const middleware = (directives: Directives) => {
  const value = format(directives)
  return <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.map(handler, (response) => HttpServerResponse.setHeader(response, 'cache-control', value))
}
