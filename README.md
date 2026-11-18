# @totto2727/effect-http

HTTP content negotiation, response caching, and security middleware for Effect 4.

## Setup

Use an ESM project with Node.js 24 or newer and Effect 4.1.4 or newer within major version 4.
Install with:

```bash
vp add @totto2727/effect-http effect@^4.1.4
```

Effect is the only runtime peer dependency.

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
Handle `None` explicitly, for example by returning `406`.

Media negotiation respects range specificity, parameters, and quality-zero exclusions.
Language negotiation uses RFC 4647 basic filtering: `en` matches an offered `en-US`, but `en-US` does not match an offered `en`.
Equal effective qualities use server offer order, while duplicate ranges of equal specificity use the lowest quality.
Malformed or oversized headers fail parsing.
The exported JSDoc describes the grammar and parser limits.

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
With Effect compression, use `app.pipe(ConditionalRequest.middleware(options), HttpMiddleware.compression(compressionOptions))` so validation runs on the final representation.
For compressed streams, supply a known validator, preferably weak when it identifies equivalent content across encodings.
A strong ETag must describe the final response bytes.

### Cache-Control

`CacheControl.parse(value)` returns `Result<Directives, ParseError>`.
Use `Result.match` to handle typed directives or the error's `reason`.
`CacheControl.format(directives)` validates application configuration and serializes a header, throwing `CacheControl.ConfigError` for invalid configuration.
`CacheControl.middleware(directives)` applies that header to successful responses.

Supported directives include visibility, freshness, revalidation, immutable, no-transform, only-if-cached, min-fresh, and max-stale.
Duplicate directives, conflicting visibility, and unsupported directives are rejected.

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
The cache stores only successful GET responses with bounded in-memory bodies.

Authorization, Cookie, range, conditional requests, Pragma, and request freshness constraints bypass reuse and storage.
Responses with Set-Cookie, Expires, private/no-store/no-cache, unknown or undeclared Vary, streaming bodies, or SSE content are not stored.
Response max-age/s-maxage and existing Age/Date limit the configured lifetime, and hits receive an updated Age.
Every configured variant participates in the key and is emitted in Vary on stored responses, even if the origin omits it.

QUERY caching, stale serving, and background revalidation are not supported.
Call `invalidateAll` after writes, including mutations outside the cached route.
Invalidation prevents pending reads from repopulating the cache but does not cancel their responses.

## CSRF and security headers

`Csrf.decide({ method, url, origin, secFetchSite }, config)` exposes the same decision used by `Csrf.middleware(config)`.
`allowedOrigins` accepts additional exact origins, not wildcards or URL paths.
GET, HEAD, and OPTIONS pass without proof.
Unsafe methods, including JSON requests, require a trusted Origin or same-origin Fetch Metadata, and contradictory metadata is rejected.
The middleware does not read forwarded headers, rejects with `403` and `Cache-Control: no-store` before the handler runs, and merges `Origin` and `Sec-Fetch-Site` into Vary.
Relative server targets require Host and use the server request's protocol, defaulting to HTTP as Effect does.
For TLS termination, configure trusted proxy handling at the application's boundary so the request carries the correct protocol.
Use this policy on browser-authenticated routes, not as authentication for non-browser clients that can forge these headers.

`SecureHeaders.headers(config)` is a pure serializer.
`SecureHeaders.serializeContentSecurityPolicy(policy)` formats a typed static CSP and rejects header and directive delimiter injection.
`SecureHeaders.middleware(config)` applies the serialized policy and removes `X-Powered-By`.
Defaults include nosniff, frame denial, no-referrer, same-origin opener policy, and same-origin resource policy.
These defaults may require adjustment for embedded documents and cross-origin resources.
HSTS and CSP are opt-in because deployment and resource policies are application-specific.
Nonce generation, rendering integration, and reporting are not included.

## Scope and upstream

See the [Hono import-path table](./docs/hono-compatibility.md) for API mappings and the [upstream record](./docs/upstream-differences.md) for pinned revisions and policy differences.
Application rendering and hosting remain in [effront](https://github.com/totto2727-org/effront).

## Development and license

See [AGENTS.md](./AGENTS.md) for maintenance and validation instructions.
The package is MIT licensed.
See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
