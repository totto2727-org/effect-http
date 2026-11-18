# @totto2727/effect-http

HTTP content negotiation, cache policies, conditional requests, and security middleware for Effect 4.

## Usage

Define routes with Effect HTTP and apply middleware to the application, not to a prebuilt response.
This example serves a negotiated message and updates it from a schema-decoded JSON request.
The state and cache are shared across requests to this application instance.

```ts
import * as Accepts from '@totto2727/effect-http/accepts'
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import * as ConditionalRequest from '@totto2727/effect-http/conditionalRequest'
import * as Csrf from '@totto2727/effect-http/csrf'
import * as ResponseCache from '@totto2727/effect-http/responseCache'
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'
import { Effect, Layer, Option, Ref, Schema } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

const Message = Schema.Struct({ text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) })

const makeApp = Effect.gen(function* () {
  const message = yield* Ref.make({ text: 'Hello' })
  const cache = yield* ResponseCache.make({
    publicRoute: true,
    capacity: 128,
    ttlMilliseconds: 30_000,
    maxBodyBytes: 4096,
    vary: ['accept'],
  })

  const readMessage = Effect.gen(function* () {
    const selected = yield* Accepts.negotiateEffect('mediaType', ['application/json', 'text/plain'])
    return yield* Option.match(selected, {
      onNone: () =>
        HttpServerResponse.json({ error: 'Not acceptable' }, { status: 406, headers: { 'cache-control': 'no-store' } }),
      onSome: (mediaType) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(message)
          return mediaType === 'application/json'
            ? yield* HttpServerResponse.json(current)
            : HttpServerResponse.text(current.text)
        }).pipe(CacheControl.middleware({ public: true, maxAge: 30 })),
    })
  }).pipe(
    Effect.catchTag('AcceptsParseError', () =>
      HttpServerResponse.json(
        { error: 'Invalid Accept header' },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      ),
    ),
    // All negotiated responses, including errors, depend on Accept.
    Effect.map(HttpServerResponse.setHeader('vary', 'accept')),
  )

  const updateMessage = Effect.gen(function* () {
    const next = yield* HttpServerRequest.schemaBodyJson(Message)
    yield* Ref.set(message, next)
    yield* cache.invalidateAll
    return yield* HttpServerResponse.json(next)
  }).pipe(
    Effect.catchTags({
      SchemaError: () => HttpServerResponse.json({ error: 'Invalid message' }, { status: 400 }),
      HttpServerError: () => HttpServerResponse.json({ error: 'Invalid request body' }, { status: 400 }),
    }),
    CacheControl.middleware({ noStore: true }),
  )

  const ReadPolicy = HttpRouter.middleware((app) =>
    app.pipe(
      cache.middleware,
      ConditionalRequest.middleware({ maxBodyBytes: 4096 }),
      Effect.provide(Digest.layerWebCrypto),
    ),
  ).layer
  const Routes = Layer.mergeAll(
    HttpRouter.add('GET', '/message', readMessage).pipe(Layer.provide(ReadPolicy)),
    HttpRouter.add('POST', '/message', updateMessage),
    HttpRouter.add('*', '*', (request) =>
      HttpServerResponse.json({ error: 'Not found', path: request.url }, { status: 404 }),
    ),
  )
  const BrowserPolicy = HttpRouter.middleware((app) => app.pipe(Csrf.middleware(), SecureHeaders.middleware()), {
    global: true,
  })
  return HttpRouter.toWebHandler(Layer.mergeAll(Routes, BrowserPolicy), { disableLogger: true })
})

const app = await Effect.runPromise(makeApp)
try {
  const json = await app.handler(
    new Request('https://example.com/message', { headers: { accept: 'application/json' } }),
  )
  console.log(json.status, await json.json()) // 200 { text: 'Hello' }

  const update = await app.handler(
    new Request('https://example.com/message', {
      method: 'POST',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      body: '{"text":"Updated"}',
    }),
  )
  console.log(update.status) // 200; invalidates every cached representation

  const text = await app.handler(new Request('https://example.com/message', { headers: { accept: 'text/plain' } }))
  console.log(await text.text()) // Updated
} finally {
  await app.dispose()
}
```

The read route negotiates before constructing its response and marks only successful representations public.
The read policy caches full successful representations before the conditional-response step.
Conditional requests deliberately bypass this route cache and evaluate the current representation, returning `304` when its validator matches.
`Csrf` wraps route execution, so a rejected write cannot update state or invalidate the cache.
`SecureHeaders` wraps `Csrf`, so its headers also apply to `403` responses.
Use `HttpRouter.middleware` for response-changing policies, not the outer `toWebHandler` middleware option.
This demo keeps its message in memory. Replace the `Ref` with application storage and add authorization for protected writes.

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
Use `negotiateEffect` inside a route, as in Usage. Return `406` when no representation matches and `400` for a malformed header.
For standalone inputs, compose `Result` values without throwing and handle the no-match case explicitly:

```ts
import * as Accepts from '@totto2727/effect-http/accepts'
import { Option, Result } from 'effect'

const kind: Accepts.Kind = 'mediaType'
const header = 'application/json, text/plain;q=0.5'
const offers = ['text/plain', 'application/json']
const request = new Request('https://example.com/message', { headers: { accept: header } })

const selections = Result.gen(function* () {
  const parsed: Accepts.Parsed = yield* Accepts.parse(kind, header)
  const fromHeader = yield* Accepts.negotiate(kind, header, offers)
  const fromHeaders = yield* Accepts.negotiateHeaders(kind, request.headers, offers)
  const fromRequest = yield* Accepts.negotiateRequest(kind, request, offers)
  return { parsed, fromHeader, fromHeaders, fromRequest }
})
Result.match(selections, {
  onFailure: (error) => console.error(error.reason),
  onSuccess: ({ fromRequest }) => console.log(Option.getOrElse(fromRequest, () => 'No acceptable representation')), // application/json
})
```

To use a standalone `Result` in an Effect program, use `Effect.fromResult` to preserve its typed error channel rather than `getOrThrow`.

### `cacheControl`

`parse` rejects duplicates, unsupported directives, and conflicting visibility with a `ParseError`.
`format` and `middleware` accept plain `Directives` and throw `ConfigError` for invalid configuration.
Usage applies `middleware` to the read handler's successful representation and separately makes write responses non-cacheable.

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import { Result } from 'effect'

const directives: CacheControl.Directives = { public: true, maxAge: 30 }
const header = CacheControl.format(directives)
console.log(header) // public, max-age=30
Result.match(CacheControl.parse(header), {
  onFailure: (error) => console.error(error.reason),
  onSuccess: (policy) => console.log(policy.maxAge), // 30
})
```

### `conditionalRequest`

Use `parseEtag` to validate a quoted ETag and `matches` to compare validators.
Call `evaluate` before a write. Only `Proceed` permits the write.
`apply` evaluates known validators against the current request and a freshly loaded representation.
`middleware`, used on the read route in Usage, can generate ETags for bounded in-memory GET bodies using the caller's `Digest` service. It does not buffer streams.
Invalid validator or middleware configuration can raise `ConfigError`.

```ts
import * as ConditionalRequest from '@totto2727/effect-http/conditionalRequest'
import { Effect, Option, Ref } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

const stored = await Effect.runPromise(Ref.make({ text: 'Hello', etag: '"revision-8"' }))
const Route = HttpRouter.add(
  'GET',
  '/message',
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const current = yield* Ref.get(stored)
    const etag = yield* Effect.fromOption(Option.fromNullishOr(ConditionalRequest.parseEtag(current.etag)))
    const previous = Option.fromNullishOr(ConditionalRequest.parseEtag(request.headers['if-none-match'] ?? ''))
    console.log(Option.exists(previous, (value) => ConditionalRequest.matches(etag, value, true))) // true
    const validators: ConditionalRequest.Validators = { etag }
    const evaluation: ConditionalRequest.Evaluation = {
      ...validators,
      method: request.method,
      headers: request.headers,
    }
    const decision: ConditionalRequest.Decision = ConditionalRequest.evaluate(evaluation)
    console.log(decision) // NotModified
    const response = yield* HttpServerResponse.json({ text: current.text })
    return ConditionalRequest.apply(response, request, validators)
  }),
)
const app = HttpRouter.toWebHandler(Route, { disableLogger: true })
try {
  const response = await app.handler(
    new Request('https://example.com/message', { headers: { 'if-none-match': '"revision-8"' } }),
  )
  console.log(response.status) // 304
} finally {
  await app.dispose()
}
```

### `csrf`

`decide` returns a `Decision` for a request. `middleware` rejects unsafe requests without trusted proof before the handler runs and returns a no-store `403`.
Usage installs it around the routes, outside their application work and inside `SecureHeaders`.
The config accepts additional exact HTTP(S) origins. The library uses `Schema.URLFromString` and checks the normalized URL properties.
Invalid configured origins throw `ConfigError` with a `message` and a required `cause` of type `Schema.SchemaError`.

```ts
import * as Csrf from '@totto2727/effect-http/csrf'

const config: Csrf.Config = { allowedOrigins: ['https://trusted.example'] }
const request: Csrf.Request = {
  method: 'POST',
  url: 'https://example.com/message',
  origin: 'https://trusted.example',
}
const decision: Csrf.Decision = Csrf.decide(request, config)
console.log(decision.allowed) // true
```

### `responseCache`

Use `make` once per intended sharing boundary, not once per request.
Specify capacity, lifetime, body size, and every request header that varies the public response in `Options`.
The cache bypasses authenticated or cookie-bearing requests and does not buffer streaming responses. Invalid configuration raises `ConfigError`.
Usage places the returned `middleware` on the public read route only and executes `invalidateAll` after a successful write.
A different `Accept` header has its own cache entry.

```ts
import * as ResponseCache from '@totto2727/effect-http/responseCache'

const options: ResponseCache.Options = {
  publicRoute: true,
  capacity: 128,
  ttlMilliseconds: 30_000,
  maxBodyBytes: 4096,
  vary: ['accept'],
}
console.log(options.vary) // [ 'accept' ]
```

### `secureHeaders`

`headers` returns a frozen header map. `serializeContentSecurityPolicy` formats a static CSP.
`middleware`, used as the outer response policy in Usage, applies the policy and removes `X-Powered-By`.
Set CSP for the resources your application uses. Enable HSTS only for an HTTPS-only deployment. Invalid policy throws `ConfigError`.

```ts
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'

const directive: SecureHeaders.CspDirective = 'default-src'
const policy: SecureHeaders.ContentSecurityPolicy = { [directive]: ["'self'"] }
const config: SecureHeaders.Config = { contentSecurityPolicy: policy }
console.log(SecureHeaders.serializeContentSecurityPolicy(policy)) // default-src 'self'
console.log(SecureHeaders.headers(config)['x-frame-options']) // DENY
```

## Development

For project structure and development commands, see [AGENTS.md](./AGENTS.md).
See the [Hono import-path table](./docs/hono-compatibility.md) and [upstream record](./docs/upstream-differences.md) for migration details.

## License

MIT. See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
