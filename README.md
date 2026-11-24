# @totto2727/effect-http

HTTP content negotiation, cache policies, conditional requests, and security middleware for Effect 4.

## Usage

Start a Node.js server with a cache policy for public reads, CSRF protection for writes, and security headers for both:

```ts
import { createServer } from 'node:http'

import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import * as Csrf from '@totto2727/effect-http/csrf'
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'
import { Effect, Layer, Schema } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

const BrowserPolicy = HttpRouter.middleware((app) => app.pipe(Csrf.middleware(), SecureHeaders.middleware())).layer
const Routes = HttpRouter.addAll([
  HttpRouter.route(
    'GET',
    '/greetings/:name',
    Effect.gen(function* () {
      const { name } = yield* HttpRouter.schemaPathParams(Schema.Struct({ name: Schema.String }))
      return yield* HttpServerResponse.json({ greeting: `Hello, ${name}` })
    }).pipe(CacheControl.middleware({ public: true, maxAge: 30 })),
  ),
  HttpRouter.route('POST', '/echo', (request) =>
    Effect.gen(function* () {
      const body = yield* request.text
      return HttpServerResponse.text(body)
    }).pipe(CacheControl.middleware({ noStore: true })),
  ),
]).pipe(Layer.provide(BrowserPolicy))

HttpRouter.serve(Routes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 3000 })),
  Layer.launch,
  NodeRuntime.runMain,
)
```

`GET /greetings/Ada` returns `{"greeting":"Hello, Ada"}` with `Cache-Control: public, max-age=30`.
Same-origin `POST /echo` returns its request body; untrusted cross-site writes receive `403`.
`SecureHeaders` wraps `Csrf`, so rejected writes also receive security headers.

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

For the Node.js server in Usage, also install the runtime adapter:

```bash
vp add @effect/platform-node@^4.1.4
```

Import the module you need from its subpath. The package has no root export.

## API

Each example defines routes with `HttpRouter.route` and registers them with `HttpRouter.addAll`.
Apply middleware directly to a single handler with `pipe`. Use a middleware layer to share a policy across several routes, as in Usage.
`listProducts` and `updateProfile` stand for your application's Effect handlers, which load products or update a profile and return an HTTP response.
Register the resulting `Routes` layer with your server. The `conditionalRequest` example includes startup to show where to provide its digest dependency.

### `accepts`

Require a JSON-compatible `Accept` header before running the route.
Return `406` when no format matches and `400` for malformed syntax.

```ts
import * as Accepts from '@totto2727/effect-http/accepts'
import { Effect, Option, Result } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

import { listProducts } from './products.ts'

const acceptJson = <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.gen(function* () {
    const negotiated = yield* Effect.result(Accepts.negotiateEffect('mediaType', ['application/json']))
    if (Result.isFailure(negotiated)) {
      return yield* HttpServerResponse.json({ error: 'Invalid Accept header' }, { status: 400 })
    }
    if (Option.isNone(negotiated.success)) {
      return yield* HttpServerResponse.json({ error: 'Not acceptable' }, { status: 406 })
    }
    return yield* app
  }).pipe(Effect.map(HttpServerResponse.setHeader('vary', 'accept')))

const Routes = HttpRouter.addAll([HttpRouter.route('GET', '/products', listProducts.pipe(acceptJson))])
```

### `cacheControl`

Allow browsers and shared caches to reuse a public response for 30 seconds.
This sets the header; it does not store responses on the server.

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import { HttpRouter } from 'effect/http'

import { listProducts } from './products.ts'

const Routes = HttpRouter.addAll([
  HttpRouter.route('GET', '/products', listProducts.pipe(CacheControl.middleware({ public: true, maxAge: 30 }))),
])
```

### `conditionalRequest`

Generate an ETag and return `304` when the client's `If-None-Match` matches.
Provide the digest implementation alongside the Node.js server layer at startup.
The middleware does not buffer streamed bodies.

```ts
import { createServer } from 'node:http'

import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import * as ConditionalRequest from '@totto2727/effect-http/conditionalRequest'
import { Layer } from 'effect'
import { Digest } from 'effect/crypto'
import { HttpRouter } from 'effect/http'

import { listProducts } from './products.ts'

const Routes = HttpRouter.addAll([
  HttpRouter.route('GET', '/products', listProducts.pipe(ConditionalRequest.middleware({ maxBodyBytes: 4096 }))),
])

HttpRouter.serve(Routes).pipe(
  Layer.provide([NodeHttpServer.layer(createServer, { host: '127.0.0.1', port: 3000 }), Digest.layerWebCrypto]),
  Layer.launch,
  NodeRuntime.runMain,
)
```

### `csrf`

Reject untrusted cross-site writes before the handler runs.
Use this in addition to authentication and authorization.

```ts
import * as Csrf from '@totto2727/effect-http/csrf'
import { HttpRouter } from 'effect/http'

import { updateProfile } from './profile.ts'

const Routes = HttpRouter.addAll([HttpRouter.route('POST', '/profile', updateProfile.pipe(Csrf.middleware()))])
```

### `responseCache`

Cache public GET responses in memory.
Route registration creates one cache at startup and shares it across requests.
The route must mark its responses public; declare any varying request headers in `vary`.

```ts
import * as CacheControl from '@totto2727/effect-http/cacheControl'
import * as ResponseCache from '@totto2727/effect-http/responseCache'
import { Effect } from 'effect'
import { HttpRouter } from 'effect/http'

import { listProducts } from './products.ts'

const Routes = HttpRouter.addAll(
  Effect.gen(function* () {
    const cache = yield* ResponseCache.make({
      publicRoute: true,
      capacity: 128,
      ttlMilliseconds: 30_000,
      maxBodyBytes: 4096,
      vary: [],
    })
    const cachedProducts = listProducts.pipe(CacheControl.middleware({ public: true, maxAge: 30 }), cache.middleware)
    return [HttpRouter.route('GET', '/products', cachedProducts)]
  }),
)
```

Only use this for responses independent of user identity.
When a write changes the underlying data, run `invalidateAll` on the same cache instance from the write effect.

### `secureHeaders`

Apply the default security headers to your routes and remove `X-Powered-By`.

```ts
import * as SecureHeaders from '@totto2727/effect-http/secureHeaders'
import { HttpRouter } from 'effect/http'

import { listProducts } from './products.ts'

const Routes = HttpRouter.addAll([HttpRouter.route('GET', '/products', listProducts.pipe(SecureHeaders.middleware()))])
```

## Development

For project structure and development commands, see [AGENTS.md](./AGENTS.md).
Use the [Hono migration guide](https://github.com/totto2727-org/effect-http/blob/main/.agents/skills/effect-http/references/hono-to-effect/README.md) to replace each import.
See the [compatibility table](./docs/hono-compatibility.md) and [upstream record](./docs/upstream-differences.md) for scope and comparison revisions.

## License

MIT. See [NOTICE](./NOTICE) for the Hono upstream notice.

_This README was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [README template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/readme/template.md)._
