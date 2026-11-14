# @totto2727/effect-http

Standalone HTTP negotiation, caching, and security policies for Effect 4.
The package fills specific gaps rather than reproducing Hono or wrapping HTTP features that Effect already provides.

## Setup

Use an ESM project with Node.js 24 or newer and Effect 4.1.4 or newer within major version 4.
When registry publication is enabled, install with:

```bash
vp add @totto2727/effect-http effect@^4.1.4
```

The repository is currently private and npm publishing is disabled.
Effect is the only runtime peer dependency.
Hono is neither installed nor bundled.

## Content negotiation without middleware

```ts
import { Accepts } from '@totto2727/effect-http'
import { Option, Result } from 'effect'

const result = Accepts.negotiate('mediaType', 'application/json, text/plain;q=0.5', ['text/plain', 'application/json'])

if (Result.isSuccess(result)) {
  console.log(Option.getOrUndefined(result.success)) // application/json
}

const requestResult = Accepts.negotiateRequest(
  'language',
  new Request('https://example.com', {
    headers: { 'accept-language': 'en-US, en;q=0.8' },
  }),
  ['ja', 'en'],
)
```

| API                                                 | Input and output                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Accepts.parse(kind, header)`                       | Parses `string \| null` into `Result<Parsed, ParseError>`.                                   |
| `Accepts.negotiate(kind, header, supports)`         | Returns `Result<Option<string>, ParseError>`, preserving the selected entry from `supports`. |
| `Accepts.negotiateHeaders(kind, headers, supports)` | Reads Web `Headers` without an Effect runtime.                                               |
| `Accepts.negotiateRequest(kind, request, supports)` | Reads a Web `Request` without consuming its body.                                            |
| `Accepts.negotiateEffect(kind, supports)`           | Returns an Effect requiring `HttpServerRequest`, with a typed `ParseError`.                  |

`kind` is `mediaType`, `language`, `encoding`, or `charset`.
A missing header accepts any supported offer.
An empty header accepts none, except for the implicit `identity` encoding.
There is no fallback that returns a representation the client rejected.
Applications map `None` to `406`, an application error, or another explicit policy.

Media negotiation respects range specificity, parameters, and quality-zero exclusions.
Language negotiation uses RFC 4647 basic filtering: `en` matches an offered `en-US`, but `en-US` does not match an offered `en`.
Encoding negotiation handles the implicit `identity` coding separately from wildcards.
Equal effective qualities use server offer order, while duplicate ranges of equal specificity use the lowest quality.
Malformed input fails the entire parse instead of accepting a permissive subset.
The parser bounds header size, range count, and parameters, and rejects unsupported extensions after `q`.
See the exported JSDoc for the exact bounds and grammar.

## Response policies

```ts
import { CacheControl, ConditionalRequest, Csrf, SecureHeaders } from '@totto2727/effect-http'
import { Effect } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpServerResponse } from 'effect/http'

const app = Effect.succeed(HttpServerResponse.text('Hello')).pipe(
  CacheControl.middleware({ public: true, maxAge: 60 }),
  ConditionalRequest.middleware({ maxBodyBytes: 64 * 1024 }),
  Csrf.middleware(),
  SecureHeaders.middleware(),
)

// Provide platform services only at your application's composition root.
const configured = app.pipe(Effect.provide(Digest.layerWebCrypto))
```

`configured` still requires the HTTP request service supplied by the server.
The library does not build a runtime or provide cryptographic services internally.
Automatic conditional handling runs in Effect's pre-response phase, not merely after the route handler.
With Effect's deferred compression middleware, use `app.pipe(ConditionalRequest.middleware(options), HttpMiddleware.compression(compressionOptions))` so compression registers first and validation runs on the selected response afterward.
Compressed streams are not buffered to invent an ETag; supply a known validator, preferably weak when it identifies equivalent content across encodings.
Other response transformations must preserve this ordering contract: a strong ETag describes the final representation bytes.

### Cache-Control

`CacheControl.parse(value)` returns a `Success` with typed directives or an `Invalid` reason.
`CacheControl.format(directives)` validates application configuration and serializes a header, throwing for invalid configuration.
`CacheControl.middleware(directives)` applies that header to successful responses.

The initial grammar supports visibility, freshness, revalidation, immutable, no-transform, only-if-cached, min-fresh, and max-stale directives.
Duplicate directives, conflicting visibility, unknown extensions, and unsupported forms are rejected rather than silently ignored.
This conservative grammar can bypass caching for headers that a full HTTP cache would understand.

### Conditional requests

`ConditionalRequest.parseEtag`, `matches`, and `evaluate` are usable without middleware.
`evaluate({ method, headers, etag, lastModified, exists })` returns `Proceed`, `NotModified`, or `PreconditionFailed`.
Header record keys must be lowercase, as in Effect HTTP headers.
Use Effect's existing `Etag` type for validators.

`ConditionalRequest.apply(response, request, validators)` applies validators and conditional response handling to a selected response.
Automatic `middleware({ maxBodyBytes })` handles GET/HEAD in the pre-response phase and generates SHA-256 validators only for GET responses with bounded `Empty` or `Uint8Array` bodies, using the caller's `Digest` service.
HEAD uses existing validators but never hashes an empty HEAD body as if it were the GET representation.
It does not drain streams or read files, raw bodies, or FormData.
For streaming or static content, supply known validators or use Effect's static server.

**Evaluate write preconditions before performing a mutation.**
Response middleware cannot undo side effects.
A matching `If-None-Match` becomes `304` for GET/HEAD and `412` for unsafe methods in the pure evaluator.
A `304` retains validators, Vary, cookies, and selected-representation encoding metadata but removes body-length and body-type headers.

### Public route response cache

```ts
import { CacheControl, ResponseCache } from '@totto2727/effect-http'
import { Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

const program = Effect.gen(function* () {
  const cache = yield* ResponseCache.make({
    publicRoute: true,
    capacity: 128,
    ttlMilliseconds: 60_000,
    maxBodyBytes: 64 * 1024,
    vary: ['accept-language'],
  })
  const route = Effect.succeed(HttpServerResponse.text('Public content')).pipe(
    CacheControl.middleware({ public: true, maxAge: 30 }),
    cache.middleware,
  )
  // Keep route and cache.invalidateAll together in the application service.
  return { route, invalidate: cache.invalidateAll }
})
```

Create one cache per intended sharing boundary, not once per request.
`publicRoute: true` is a caller guarantee that output depends only on the request target, host, and declared header variants, never undeclared identity or headers.
The cache uses Effect's capacity-bounded cache and Clock, with no process-global state.
It stores only successful GET responses with bounded in-memory bodies and copies bytes before storage and on hits.

Authorization, Cookie, range, conditional requests, Pragma, and request freshness constraints bypass reuse and storage.
Responses with Set-Cookie, Expires, private/no-store/no-cache, unknown or undeclared Vary, streaming bodies, or SSE content are not stored.
Expires is deliberately bypassed rather than partially implementing its interaction with other freshness directives.
Response max-age/s-maxage and existing Age/Date limit the configured lifetime, and hits receive an updated Age.
Every configured variant participates in the key and is emitted in Vary on stored responses, even if the origin omits it.

This is an explicit public route cache, not a full RFC 9111 proxy cache.
It does not implement QUERY caching, stale serving, background revalidation, range combination, or automatic cross-route mutation invalidation.
Call `invalidateAll` after writes, including mutations outside the cached route.
Invalidation fences older in-flight reads from repopulating the current cache generation, but does not cancel those callers or undo the response they already selected.

## CSRF and security headers

`Csrf.decide({ method, url, origin, secFetchSite }, config)` exposes the same decision used by `Csrf.middleware(config)`.
Configuration accepts additional exact `allowedOrigins`; paths, credentials, queries, fragments, malformed origins, and wildcard origins are rejected.
GET, HEAD, and OPTIONS pass without proof.
Unsafe methods, including JSON requests, require a trusted Origin or same-origin Fetch Metadata, and contradictory metadata is rejected.
The middleware does not read forwarded headers, rejects with `403` and `Cache-Control: no-store` before the handler runs, and merges `Origin` and `Sec-Fetch-Site` into Vary.
Relative server targets require Host and use the server request's protocol, defaulting to HTTP as Effect does.
For TLS termination, configure trusted proxy handling at the application's boundary so the request carries the correct protocol.
Use this policy on browser-authenticated routes, not as authentication for non-browser clients that can forge these headers.
Server-to-server routes that omit browser headers need a separate explicit policy.

`SecureHeaders.headers(config)` is a pure serializer.
`SecureHeaders.serializeContentSecurityPolicy(policy)` formats a typed static CSP and rejects header and directive delimiter injection.
`SecureHeaders.middleware(config)` applies the serialized policy and removes `X-Powered-By`.
Defaults include nosniff, frame denial, no-referrer, same-origin opener policy, and same-origin resource policy.
These defaults may require adjustment for embedded documents and cross-origin resources.
HSTS and CSP are opt-in because deployment and resource policies are application-specific.
Nonce generation, rendering integration, and reporting are not included.

## Scope and upstream

The [Hono feature table](./docs/hono-compatibility.md) covers all 27 built-in middleware and 14 helpers at the recorded Hono commit.
It documents implementation, existing Effect alternatives, and exclusions for every entry.
The [upstream record](./docs/upstream-differences.md) pins Hono, Effect, and template revisions and explains retained security and operational differences.
Hono is a behavioral upstream, not a runtime dependency or a source-tree fork.
Effect 3 and `@effect/platform` compatibility are not provided.

## Development and license

See [AGENTS.md](./AGENTS.md) for maintenance and validation instructions.
The package is MIT licensed.
See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
