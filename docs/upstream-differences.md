# Upstream differences

## Comparison baseline

| Role                          | Repository                                                                                      | Exact revision                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Behavioral upstream           | [honojs/hono](https://github.com/honojs/hono)                                                   | `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823` (4.13.18) |
| Effect comparison             | [Effect-TS/effect](https://github.com/Effect-TS/effect)                                         | `3e2030b43e86a60113f2f32671076ff3b1d84ce4` (4.1.4)   |
| Effect development dependency | [Effect-TS/effect](https://github.com/Effect-TS/effect)                                         | `e3aca1f1484e623cee09b7f3fa18d6ff5d66c0e8` (4.1.5)   |
| Scope boundary reference      | [totto2727-org/effront](https://github.com/totto2727-org/effront)                               | `3c8c55c8f99242b0c45c5a672fe3ea22f9e26614`           |
| Library scaffold              | [totto2727-org/template-vite-plus-lib](https://github.com/totto2727-org/template-vite-plus-lib) | `93c04d34cbb70971ea1db6790980d22f55ed095e`           |

Hono is the behavioral upstream for selected helpers and middleware policies.
This repository starts from the Vite library template, not from Hono's Git history.
It does not contain a modified Hono router or a nested Hono runtime.
The Git remote `upstream` points to `https://github.com/honojs/hono.git`.
The Git remote `origin` points to `https://github.com/totto2727-org/effect-http.git`.

The committed [import-path disposition table](./hono-compatibility.md) records all 104 concrete public Hono import paths in the comparison baseline.
The 77 export declarations contain 76 fixed paths and one wildcard pattern whose 28 existing utility modules are emitted by Hono's pinned build rules.
Nested JWT imports, type-only modules, core/router/JSX entries, and deprecated adapters are included separately.
Every row names a concrete Effect or effront counterpart or states a specific exclusion reason.
Effront is a scope boundary reference, not an additional runtime dependency or a source upstream.
The upstream license is retained in [NOTICE](../NOTICE).

## Purpose and affected areas

This package supplies standalone HTTP policy logic and thin Effect adapters.
It does not provide Hono API compatibility or a second HTTP framework.
Effect remains the only runtime peer dependency.
Policy composition uses Effect's collection and string APIs, `Result` and `Option`, and `Ref` for cache invalidation state.
`CacheControl.parse` returns `Result<Directives, ParseError>` rather than a package-specific result union.
Custom errors use `Data.TaggedError`, and ETag values use Effect-generated tagged constructors.
Missing-value checks use Effect's nullish APIs instead of distinguishing `null` from `undefined`.
`Accepts.parse` and `Accepts.negotiate` accept either missing-value representation.
Media parameters use Effect `Record` construction and own-key lookup, including names such as `__proto__` and `constructor`, without a custom prototype conversion.
CSRF URL decoding delegates to `Schema.URLFromString`; relative request targets use `HttpServerRequest.toURL` instead of manually assembling a URL.
Absolute request targets retain their authority, and missing Host values cannot silently become localhost proof.
HTTP(S), credential, path, query, and fragment restrictions apply to URL values decoded and normalized by Effect, not to a separately parsed raw URL grammar.
Equivalent inputs normalized by `Schema.URLFromString`, such as dot segments or empty user information, use the resulting origin for policy decisions.
Empty query and fragment markers are accepted when the decoded URL's `search` and `hash` properties are empty; nonempty query and fragment values are rejected.
Named Schemas own format and size constraints; decoded Schema-derived brands carry validated values into policy logic.
Negotiation ordering, directive conflicts, conditional request precedence, and cache eligibility remain decision logic rather than value constraints.
The six camelCase module subpaths are the public entry points; there is no root barrel export.
These implementation choices preserve the documented HTTP policies rather than reproduce Hono's internal control flow.
Hono is not installed or bundled.

| Area                     | Hono baseline                                             | Retained difference and operational impact                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content negotiation      | `src/helper/accepts` and `src/utils/accept.ts`            | Parsing and matching are public outside middleware. String input, request headers, and Effect request access use the same policy. A missing match is explicit instead of returning a possibly forbidden default. Quality-zero exclusions and malformed input cannot silently become accepted values.                                                                                                                |
| Language selection       | `src/middleware/language`                                 | Only reusable header negotiation belongs here. Query, cookie, and path precedence remain application policy. There is no Hono Context variable or language-cookie lifecycle.                                                                                                                                                                                                                                        |
| Cache-Control            | `src/middleware/cache`                                    | Parsing and formatting are reusable APIs. Invalid or conflicting policy is handled conservatively. This is part of HTTP response caching, not a separate cache framework.                                                                                                                                                                                                                                           |
| Response cache           | `src/middleware/cache`                                    | The first version caches explicitly configured, bounded, in-memory GET responses. Requests carrying Authorization or Cookie bypass the shared cache. Private, no-store, no-cache, Set-Cookie, Expires, undeclared Vary, and streaming responses are not stored. Declared variants are keyed and emitted in Vary. Manual invalidation fences older in-flight insertions by generation.                               |
| Cache backend            | Web standard `Cache` API and `executionCtx.waitUntil`     | Uses Effect's cache and Clock abstractions instead of depending on a global edge cache or detached writes. It does not silently become a no-op when `globalThis.caches` is absent. It is a route response cache, not a complete RFC proxy cache.                                                                                                                                                                    |
| QUERY caching            | Hono supports QUERY body digests                          | QUERY responses are not cached in this version. No request body is consumed to manufacture a cache key. Hono parity for new HTTP methods is not implied.                                                                                                                                                                                                                                                            |
| Entity tags              | `src/middleware/etag`                                     | Effect's entity-tag types and existing file validators remain in use. Automatic SHA-256 generation covers bounded GET response bytes and requires the caller's Digest service. HEAD uses known validators rather than hashing its empty body. Streams are never drained.                                                                                                                                            |
| Conditional requests     | Hono's response ETag middleware                           | Reusable decisions are not limited to Hono Context. Final-response validation uses Effect's pre-response phase; the documented composition order runs deferred compression before validation. Conditional responses preserve cookies and selected-representation metadata. Write validators must be checked before side effects, and failed write preconditions yield `412`, never `304`.                           |
| CSRF                     | `src/middleware/csrf`                                     | Protects unsafe methods rather than only browser-simple content types. Missing or invalid proof fails closed. A contradictory Fetch Metadata header cannot override an untrusted Origin. This may reject scripts and clients that omit browser headers, so apply it to browser-authenticated routes.                                                                                                                |
| Security headers         | `src/middleware/secure-headers`                           | Supplies a small policy bundle and reusable header serialization. Hono's nonce Context, JSX integration, reporting helpers, and every historical header option are not reproduced. Applications own dynamic nonce generation and inject any required Crypto service at their composition root.                                                                                                                      |
| Existing Effect features | Various Hono modules                                      | Compression, CORS, JOSE, ordinary cookies, streams, SSE, WebSocket, logging, tracing, schema validation, typed clients, and static serving are not wrapped solely to match Hono names.                                                                                                                                                                                                                              |
| Effront-owned features   | Application, JSX, HTML, CSS, host adapters, static assets | Existing React RSC/SSR, hydration/navigation, application composition, native hosting, asset serving, and Server Function runtime policies remain in effront. Generic Accept negotiation does not replace HTML/Flight selection. Public route caching does not cache private effront responses. Dynamic byte validators do not replace static-file validators. No effront dependency or integration layer is added. |
| Hono-specific features   | Router, factory, JSX, CSS, HTML, SSG, adapters            | No Hono Context, renderer, runtime detection, or router-history compatibility layer is included.                                                                                                                                                                                                                                                                                                                    |

## Publication configuration

Unlike the disabled scaffold workflow, `.github/workflows/publish.yml` is enabled and `package.json` no longer marks the package private, as explicitly requested for publication CI.
Publication runs on pushes to `main`, including merges, rather than the scaffold revision's tag-only trigger, as explicitly requested.
Job-scoped OIDC and the shared `@main` actions are unchanged.
Setup, artifact building, and the publisher use the existing hook-free Nix `ci` shell to avoid executing `vp config` before Vite+ installation.
This is release automation customization, not a Hono runtime or API change.
The owner must confirm npm trusted publishing for `totto2727-org/effect-http` and `publish.yml` before merging publication changes to `main`.
The shared action stages packages with `vp pm stage publish -r --provenance`; staging does not make a version live.
Prefer staging-only publisher permissions when available and keep review plus 2FA approval on the owner's trusted device.
See [AGENTS.md](../AGENTS.md#template-toolchain) for publication policy and owner prerequisites.
No Hono comparison revision or import-path disposition changes are required for this configuration.

## Standards boundary

HTTP cache handling follows the conservative subset described by [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html).
A response cache is not just a memoized handler: request identity, variants, authentication, freshness, and body ownership affect reuse.
The package does not claim full intermediary caching, stale serving, background revalidation, range combination, or cacheable QUERY support.

Language matching distinguishes HTTP media ranges from language ranges defined by [RFC 4647](https://www.rfc-editor.org/rfc/rfc4647.html).
HTTP media types, encodings, and language tags do not share one unrestricted wildcard algorithm.
Applications decide whether no match becomes a `406` response, another representation, or an application error.

## Update contract

When reviewing a Hono update, compare against the exact behavioral baseline above.
Update that hash together with any adopted changes.
Re-enumerate fixed exports and expand every wildcard from the pinned build output rules, not only middleware and helper directories.
Compare that concrete set with the first column in `hono-compatibility.md`, requiring zero missing, extra, and duplicate paths.
Review every row's concrete counterpart and exclusion reason, including effront scope, when an entry point or comparison revision changes.
Update the recorded effront commit together with any change to the implemented-scope boundary.
Keep safe semantic differences explicit, and remove differences that no longer serve the package's scope.
Do not merge Hono's source tree or replace the template toolchain to perform a behavioral update.
Keep this document as maintained divergence information, not as a progress log.
