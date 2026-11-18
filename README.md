# @totto2727/effect-http

HTTP content negotiation, cache policies, conditional requests, and security middleware for Effect 4.

## Usage

Make a Web handler that applies a Cache-Control policy:

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'

const handler = HttpEffect.toWebHandler(
  Effect.succeed(HttpServerResponse.text('Hello')).pipe(CacheControl.middleware({ public: true, maxAge: 60 })),
)
const response = await handler(new Request('https://example.com/'))
console.log(response.headers.get('cache-control')) // public, max-age=60
```

## Key features

- Standalone parsers for `Accept` and Cache-Control headers.
- Conditional requests and bounded caching for public GET responses.
- Origin checks and response security headers for browser-facing routes.
- ESM subpath exports with TypeScript declarations.

## Prerequisites

- **Node.js 24 or newer** and an ESM project.
- **Vite+** to use the installation command below.
- **Effect 4.1.4 or newer within major version 4**, the only runtime peer dependency.

## Setup

Install the library and its peer dependency from npm:

```bash
vp add @totto2727/effect-http effect@^4.1.4
```

Import the module you need from its subpath. The package has no root export.

## API

### `accepts`

`parse` returns a `Parsed` value with readonly, validated `Preference` entries or a `ParseError`.
`Kind` selects media type, language, encoding, or charset negotiation.
The negotiation helpers return the original matching offer as an `Option`. Invalid header syntax is a separate error.
Set `Vary` when the representation depends on negotiation. Return `406` or apply an explicit fallback if no offer matches.

```ts
import * as Accepts from '@totto2727/effect-http/accepts'
import { Effect, Option, Result } from 'effect'
import { HttpServerRequest } from 'effect/http'

const kind: Accepts.Kind = 'mediaType'
const header = 'application/json, text/plain;q=0.5'
const offers = ['text/plain', 'application/json']
const request = new Request('https://example.com/', { headers: { accept: header } })

const parsed: Accepts.Parsed = Result.getOrThrow(Accepts.parse(kind, header))
console.log(parsed)
console.log(Option.getOrThrow(Result.getOrThrow(Accepts.negotiate(kind, header, offers)))) // application/json
console.log(Option.getOrThrow(Result.getOrThrow(Accepts.negotiateHeaders(kind, request.headers, offers)))) // application/json
console.log(Option.getOrThrow(Result.getOrThrow(Accepts.negotiateRequest(kind, request, offers)))) // application/json

const selected = await Effect.runPromise(
  Accepts.negotiateEffect(kind, offers).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
  ),
)
console.log(Option.getOrThrow(selected)) // application/json
```

### `cacheControl`

`parse` rejects duplicates, unsupported directives, and conflicting visibility with a `ParseError`.
`format` and `middleware` accept plain `Directives` and throw `ConfigError` for invalid configuration.

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import { Effect, Result } from 'effect'
import { HttpServerResponse } from 'effect/http'

const directives: CacheControl.Directives = { public: true, maxAge: 60 }
const header = CacheControl.format(directives)
console.log(Result.getOrThrow(CacheControl.parse(header))) // { public: true, maxAge: 60 }

const response = await Effect.runPromise(
  CacheControl.middleware(directives)(Effect.succeed(HttpServerResponse.text('Hello'))),
)
console.log(response.headers['cache-control']) // public, max-age=60
```

### `conditionalRequest`

Use `parseEtag` to validate a quoted ETag and `matches` to compare validators.
Call `evaluate` with lowercase request header names before a write. Only `Proceed` permits the write.
`apply` uses known `Validators` on a selected response. `middleware` can generate ETags for bounded in-memory GET bodies using the caller's `Digest` service. It does not buffer streams.
Invalid validator or middleware configuration can raise `ConfigError`.

```ts
import * as ConditionalRequest from '@totto2727/effect-http/conditionalRequest'
import { Effect, Option } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http'

const etag = Option.getOrThrow(Option.fromNullishOr(ConditionalRequest.parseEtag('"revision-8"')))
const previous = Option.getOrThrow(Option.fromNullishOr(ConditionalRequest.parseEtag('"revision-7"')))
console.log(ConditionalRequest.matches(etag, previous, true)) // false

const validators: ConditionalRequest.Validators = { etag }
const evaluation: ConditionalRequest.Evaluation = {
  ...validators,
  method: 'PUT',
  headers: { 'if-match': '"revision-7"' },
}
const decision: ConditionalRequest.Decision = ConditionalRequest.evaluate(evaluation)
console.log(decision) // PreconditionFailed

const request = HttpServerRequest.fromWeb(
  new Request('https://example.com/', { headers: { 'if-none-match': '"revision-8"' } }),
)
console.log(ConditionalRequest.apply(HttpServerResponse.text('Hello'), request, validators).status) // 304

const handler = HttpEffect.toWebHandler(
  Effect.succeed(HttpServerResponse.text('Hello')).pipe(
    ConditionalRequest.middleware({ maxBodyBytes: 1024 }),
    Effect.provide(Digest.layerWebCrypto),
  ),
)
const response = await handler(new Request('https://example.com/'))
console.log(response.headers.get('etag')) // A quoted SHA-256 validator
```

### `csrf`

`decide` returns a `Decision` for a request. `middleware` rejects unsafe requests without trusted proof before the handler runs and returns a no-store `403`.
The config accepts additional exact HTTP(S) origins. The library uses `Schema.URLFromString` and checks the normalized URL properties.
Invalid configured origins throw `ConfigError` with a `message` and a required `cause` of type `Schema.SchemaError`.

```ts
import * as Csrf from '@totto2727/effect-http/csrf'
import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'

const config: Csrf.Config = { allowedOrigins: ['https://trusted.example'] }
const request: Csrf.Request = {
  method: 'POST',
  url: 'https://example.com/',
  origin: 'https://trusted.example',
}
const decision: Csrf.Decision = Csrf.decide(request, config)
console.log(decision.allowed) // true

const handler = HttpEffect.toWebHandler(Csrf.middleware(config)(Effect.succeed(HttpServerResponse.empty())))
const response = await handler(new Request(request.url, { method: request.method }))
console.log(response.status) // 403 because the request has no origin proof
```

### `responseCache`

Use `make` once per intended sharing boundary. Specify capacity, lifetime, body size, and every request header that varies the public response in `Options`.
The cache bypasses authenticated or cookie-bearing requests and does not buffer streaming responses. Invalid configuration raises `ConfigError`.
Call the returned `invalidateAll` Effect after writes that change public content.

```ts
import * as ResponseCache from '@totto2727/effect-http/responseCache'
import { Effect } from 'effect'
import { HttpEffect, HttpServerResponse } from 'effect/http'

const options: ResponseCache.Options = {
  publicRoute: true,
  capacity: 128,
  ttlMilliseconds: 60_000,
  maxBodyBytes: 1024,
  vary: ['accept-language'],
}
const cache = await Effect.runPromise(ResponseCache.make(options))
const handler = HttpEffect.toWebHandler(
  cache.middleware(
    Effect.succeed(
      HttpServerResponse.text('Public content', {
        headers: { 'cache-control': 'public, max-age=30' },
      }),
    ),
  ),
)
const response = await handler(new Request('https://example.com/', { headers: { 'accept-language': 'en' } }))
console.log(response.headers.get('vary')) // accept-language
await Effect.runPromise(cache.invalidateAll)
```

### `secureHeaders`

`headers` returns a frozen header map. `serializeContentSecurityPolicy` formats a static CSP. `middleware` applies the policy and removes `X-Powered-By`.
Set CSP for the resources your application uses. Enable HSTS only for an HTTPS-only deployment. Invalid policy throws `ConfigError`.

```ts
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'
import { Effect } from 'effect'
import { HttpServerResponse } from 'effect/http'

const directive: SecureHeaders.CspDirective = 'default-src'
const policy: SecureHeaders.ContentSecurityPolicy = { [directive]: ["'self'"] }
const config: SecureHeaders.Config = { contentSecurityPolicy: policy }
console.log(SecureHeaders.serializeContentSecurityPolicy(policy)) // default-src 'self'
console.log(SecureHeaders.headers(config)['x-frame-options']) // DENY

const response = await Effect.runPromise(
  SecureHeaders.middleware(config)(Effect.succeed(HttpServerResponse.text('Hello'))),
)
console.log(response.headers['content-security-policy']) // default-src 'self'
```

## Development

For project structure and development commands, see [AGENTS.md](./AGENTS.md).
See the [Hono import-path table](./docs/hono-compatibility.md) and [upstream record](./docs/upstream-differences.md) for migration details.

## License

MIT. See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
