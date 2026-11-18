# @totto2727/effect-http

HTTP content negotiation, cache policies, conditional requests, and security middleware for Effect 4.

## Usage

Format a Cache-Control policy:

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'

console.log(CacheControl.format({ public: true, maxAge: 30 })) // public, max-age=30
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

The examples define real routes with `HttpRouter.route` and register them with `HttpRouter.addAll`.
Use `HttpRouter.middleware` for response-changing policies, not the outer `toWebHandler` middleware option.
For a schema-declared API with generated clients or OpenAPI, use `HttpApiEndpoint` and `HttpApiBuilder` instead.
Each example is independent; combine authorization, persistence, and browser policies as your application requires.

### `accepts`

`Kind` selects media type, language, encoding, or charset negotiation.
`parse` returns a `Parsed` value with readonly, validated `Preference` entries or a `ParseError`.
`negotiate`, `negotiateHeaders`, and `negotiateRequest` work outside middleware and return a matching offer as an `Option` inside a `Result`.
`negotiateEffect` reads the current Effect server request.
This route converts no match into the existing `HttpApiError.NotAcceptable` error, and maps expected failures at its HTTP boundary.
`Vary: Accept` applies to successful and rejected negotiation alike.

```ts
import * as Accepts from '@totto2727/effect-http/accepts'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'
import { HttpApiError } from 'effect/http-api'

const Params = Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)) })
const readGreeting = Effect.gen(function* () {
  const { name } = yield* HttpRouter.schemaPathParams(Params)
  const mediaType = yield* Accepts.negotiateEffect('mediaType', ['application/json', 'text/plain']).pipe(
    Effect.flatMap(Effect.fromOption(() => new HttpApiError.NotAcceptable({}))),
  )
  const greeting = `Hello, ${name}`
  return mediaType === 'application/json'
    ? yield* HttpServerResponse.json({ greeting })
    : HttpServerResponse.text(greeting)
})
const NegotiationPolicy = HttpRouter.middleware<{
  handles: Accepts.ParseError | HttpApiError.NotAcceptable | Schema.SchemaError
}>()((app) =>
  app.pipe(
    Effect.catchTags({
      AcceptsParseError: () => HttpServerResponse.json({ error: 'Invalid Accept header' }, { status: 400 }),
      NotAcceptable: () => HttpServerResponse.json({ error: 'Not acceptable' }, { status: 406 }),
      SchemaError: () => HttpServerResponse.json({ error: 'Invalid name' }, { status: 400 }),
    }),
    Effect.map(HttpServerResponse.setHeaders({ vary: 'accept', 'cache-control': 'no-store' })),
  ),
).layer
const Routes = HttpRouter.addAll([HttpRouter.route('GET', '/greetings/:name', readGreeting)]).pipe(
  Layer.provide(NegotiationPolicy),
)
const app = HttpRouter.toWebHandler(Routes, { disableLogger: true })
try {
  const response = await app.handler(
    new Request('https://example.com/greetings/Ada', { headers: { accept: 'text/plain' } }),
  )
  console.log(response.status, await response.text()) // 200 Hello, Ada
} finally {
  await app.dispose()
}

const kind: Accepts.Kind = 'mediaType'
const header = 'application/json, text/plain;q=0.5'
const offers = ['text/plain', 'application/json']
const request = new Request('https://example.com/greetings/Ada', { headers: { accept: header } })
const selections = Result.gen(function* () {
  const parsed: Accepts.Parsed = yield* Accepts.parse(kind, header)
  const fromHeader = yield* Accepts.negotiate(kind, header, offers)
  const fromHeaders = yield* Accepts.negotiateHeaders(kind, request.headers, offers)
  const fromRequest = yield* Accepts.negotiateRequest(kind, request, offers)
  return { parsed, fromHeader, fromHeaders, fromRequest }
})
Result.match(selections, {
  onFailure: (error) => console.error(error.reason),
  onSuccess: ({ fromRequest }) => console.log(Option.getOrElse(fromRequest, () => 'No acceptable representation')),
}) // application/json
```

### `cacheControl`

`parse` rejects duplicates, unsupported directives, and conflicting visibility with a `ParseError`.
`format` and `middleware` accept plain `Directives` and throw `ConfigError` for invalid configuration.
Apply the successful response policy before mapping expected errors, so a `400` does not inherit public caching.

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import { Effect, Layer, Result, Schema } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

const directives: CacheControl.Directives = { public: true, maxAge: 30 }
const header = CacheControl.format(directives)
Result.match(CacheControl.parse(header), {
  onFailure: (error) => console.error(error.reason),
  onSuccess: (policy) => console.log(policy.maxAge), // 30
})

const Params = Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(64)) })
const GreetingPolicy = HttpRouter.middleware<{ handles: Schema.SchemaError }>()((app) =>
  app.pipe(
    CacheControl.middleware(directives),
    Effect.catchTag('SchemaError', () =>
      HttpServerResponse.json({ error: 'Invalid name' }, { status: 400 }).pipe(
        CacheControl.middleware({ noStore: true }),
      ),
    ),
  ),
).layer
const Routes = HttpRouter.addAll([
  HttpRouter.route(
    'GET',
    '/greetings/:name',
    HttpRouter.schemaPathParams(Params).pipe(
      Effect.flatMap(({ name }) => HttpServerResponse.json({ greeting: `Hello, ${name}` })),
    ),
  ),
]).pipe(Layer.provide(GreetingPolicy))
const app = HttpRouter.toWebHandler(Routes, { disableLogger: true })
try {
  const response = await app.handler(new Request('https://example.com/greetings/Ada'))
  console.log(response.headers.get('cache-control')) // public, max-age=30
  console.log(await response.json()) // { greeting: 'Hello, Ada' }
} finally {
  await app.dispose()
}
```

### `conditionalRequest`

Use `parseEtag` to validate a quoted ETag and `matches` to compare validators.
Call `evaluate` before a write. Only `Proceed` permits the write.
`apply` evaluates known validators against the current request and a freshly loaded representation.
`middleware` generates ETags for bounded in-memory GET bodies using the caller's `Digest` service; it does not buffer streams.
The request-taking route helper supplies the current request without a manual service lookup.
Invalid validator or middleware configuration can raise `ConfigError`.

```ts
import * as ConditionalRequest from '@totto2727/effect-http/conditionalRequest'
import { Effect, Layer, Option, Ref } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpRouter, HttpServerResponse } from 'effect/http'

const stored = await Effect.runPromise(Ref.make({ text: 'Hello', etag: '"revision-8"' }))
const Known = HttpRouter.route('GET', '/message', (request) =>
  Effect.gen(function* () {
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
const GeneratedPolicy = HttpRouter.middleware((app) =>
  app.pipe(ConditionalRequest.middleware({ maxBodyBytes: 4096 }), Effect.provide(Digest.layerWebCrypto)),
).layer
const Generated = HttpRouter.addAll([
  HttpRouter.route(
    'GET',
    '/generated',
    Ref.get(stored).pipe(Effect.flatMap(({ text }) => HttpServerResponse.json({ text }))),
  ),
]).pipe(Layer.provide(GeneratedPolicy))
const app = HttpRouter.toWebHandler(Layer.mergeAll(HttpRouter.addAll([Known]), Generated), { disableLogger: true })
try {
  const unchanged = await app.handler(
    new Request('https://example.com/message', { headers: { 'if-none-match': '"revision-8"' } }),
  )
  console.log(unchanged.status) // 304
  const response = await app.handler(new Request('https://example.com/generated'))
  console.log(response.headers.get('etag')) // A quoted SHA-256 validator
} finally {
  await app.dispose()
}
```

### `csrf`

`decide` returns a `Decision` for a request. `middleware` rejects unsafe requests without trusted proof before application work and returns a no-store `403`.
The config accepts additional exact HTTP(S) origins. The library uses `Schema.URLFromString` and checks normalized URL properties.
Invalid configured origins throw `ConfigError` with a `message` and a required `cause` of type `Schema.SchemaError`.
This route decodes a JSON increment and updates shared state only after the browser policy permits the request.
CSRF protection is not authorization.

```ts
import * as Csrf from '@totto2727/effect-http/csrf'
import { Effect, Layer, Number, Ref, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

const config: Csrf.Config = { allowedOrigins: ['https://trusted.example'] }
const request: Csrf.Request = { method: 'POST', url: 'https://example.com/counter', origin: 'https://trusted.example' }
const decision: Csrf.Decision = Csrf.decide(request, config)
console.log(decision.allowed) // true

const Increment = Schema.Struct({ increment: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })) })
const makeApp = Effect.gen(function* () {
  const counter = yield* Ref.make(0)
  const Routes = HttpRouter.addAll([
    HttpRouter.route(
      'POST',
      '/counter',
      Effect.gen(function* () {
        const { increment } = yield* HttpServerRequest.schemaBodyJson(Increment)
        const count = yield* Ref.updateAndGet(counter, Number.sum(increment))
        return yield* HttpServerResponse.json({ count })
      }).pipe(
        Effect.catchTags({
          SchemaError: () => HttpServerResponse.json({ error: 'Invalid increment' }, { status: 400 }),
          HttpServerError: () => HttpServerResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
        }),
      ),
    ),
    HttpRouter.route(
      'GET',
      '/counter',
      Ref.get(counter).pipe(Effect.flatMap((count) => HttpServerResponse.json({ count }))),
    ),
  ])
  const BrowserPolicy = HttpRouter.middleware((app) => Csrf.middleware(config)(app), { global: true })
  return HttpRouter.toWebHandler(Layer.mergeAll(Routes, BrowserPolicy), { disableLogger: true })
})
const app = await Effect.runPromise(makeApp)
try {
  const denied = await app.handler(
    new Request('https://example.com/counter', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: '{"increment":1}',
    }),
  )
  console.log(denied.status) // 403
  const current = await app.handler(new Request('https://example.com/counter'))
  console.log(await current.json()) // { count: 0 }; rejected request did not update state
} finally {
  await app.dispose()
}
```

### `responseCache`

Use `make` once per sharing boundary, not once per request.
Specify capacity, lifetime, body size, and every varying request header in `Options`.
The cache bypasses authenticated, cookie-bearing, and conditional requests and does not buffer streams. Invalid configuration raises `ConfigError`.
Apply the returned `middleware` only to public read routes and execute `invalidateAll` after successful writes.
This example's representation depends only on its target and shared state, so `vary` is empty.

```ts
import * as ResponseCache from '@totto2727/effect-http/responseCache'
import { Effect, Layer, Ref, Schema } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

const Message = Schema.Struct({ text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) })
const options: ResponseCache.Options = {
  publicRoute: true,
  capacity: 128,
  ttlMilliseconds: 30_000,
  maxBodyBytes: 4096,
  vary: [],
}
const makeApp = Effect.gen(function* () {
  const message = yield* Ref.make({ text: 'Hello' })
  const cache = yield* ResponseCache.make(options)
  const ReadPolicy = HttpRouter.middleware(cache.middleware).layer
  const Read = HttpRouter.addAll([
    HttpRouter.route(
      'GET',
      '/message',
      Ref.get(message).pipe(
        Effect.flatMap((current) =>
          HttpServerResponse.json(current, { headers: { 'cache-control': 'public, max-age=30' } }),
        ),
      ),
    ),
  ]).pipe(Layer.provide(ReadPolicy))
  const Write = HttpRouter.addAll([
    HttpRouter.route(
      'POST',
      '/message',
      Effect.gen(function* () {
        const next = yield* HttpServerRequest.schemaBodyJson(Message)
        yield* Ref.set(message, next)
        yield* cache.invalidateAll
        return yield* HttpServerResponse.json(next, { headers: { 'cache-control': 'no-store' } })
      }).pipe(
        Effect.catchTags({
          SchemaError: () => HttpServerResponse.json({ error: 'Invalid message' }, { status: 400 }),
          HttpServerError: () => HttpServerResponse.json({ error: 'Invalid JSON body' }, { status: 400 }),
        }),
      ),
    ),
  ])
  return HttpRouter.toWebHandler(Layer.mergeAll(Read, Write), { disableLogger: true })
})
const app = await Effect.runPromise(makeApp)
try {
  await app.handler(new Request('https://example.com/message'))
  const hit = await app.handler(new Request('https://example.com/message'))
  console.log(hit.headers.get('age')) // 0
  await app.handler(
    new Request('https://example.com/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"Updated"}',
    }),
  )
  const current = await app.handler(new Request('https://example.com/message'))
  console.log(await current.json()) // { text: 'Updated' }; the old cache entry was invalidated
} finally {
  await app.dispose()
}
```

### `secureHeaders`

`headers` returns a frozen header map. `serializeContentSecurityPolicy` formats a static CSP.
`middleware` applies the policy and removes `X-Powered-By`.
Set CSP for the resources your application uses. Enable HSTS only for an HTTPS-only deployment. Invalid policy throws `ConfigError`.
Place this response policy outside the route's expected-error mapping so both `200` and `400` responses receive the security headers.
When combining it with `Csrf`, use `app.pipe(Csrf.middleware(), SecureHeaders.middleware(config))` so CSRF rejections also receive them.

```ts
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

const directive: SecureHeaders.CspDirective = 'default-src'
const policy: SecureHeaders.ContentSecurityPolicy = { [directive]: ["'self'"] }
const config: SecureHeaders.Config = { contentSecurityPolicy: policy }
console.log(SecureHeaders.serializeContentSecurityPolicy(policy)) // default-src 'self'
console.log(SecureHeaders.headers(config)['x-frame-options']) // DENY

const Params = Schema.Struct({ name: Schema.String.check(Schema.isMaxLength(64)) })
const Routes = HttpRouter.addAll([
  HttpRouter.route(
    'GET',
    '/greetings/:name',
    HttpRouter.schemaPathParams(Params).pipe(
      Effect.flatMap(({ name }) => HttpServerResponse.json({ greeting: `Hello, ${name}` })),
      Effect.catchTag('SchemaError', () => HttpServerResponse.json({ error: 'Invalid name' }, { status: 400 })),
    ),
  ),
])
const SecurityPolicy = HttpRouter.middleware((app) => SecureHeaders.middleware(config)(app), { global: true })
const app = HttpRouter.toWebHandler(Layer.mergeAll(Routes, SecurityPolicy), { disableLogger: true })
try {
  const response = await app.handler(new Request('https://example.com/greetings/Ada'))
  console.log(await response.json()) // { greeting: 'Hello, Ada' }
  console.log(response.headers.get('content-security-policy')) // default-src 'self'
} finally {
  await app.dispose()
}
```

## Development

For project structure and development commands, see [AGENTS.md](./AGENTS.md).
See the [Hono import-path table](./docs/hono-compatibility.md) and [upstream record](./docs/upstream-differences.md) for migration details.

## License

MIT. See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
