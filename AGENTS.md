# effect-http

## Purpose and scope

This library supplies missing HTTP negotiation, cache, and security policies for Effect 4.
Do not recreate Hono context, routers, JSX, adapters, or behavior already substantially covered by Effect.
Do not implement application, rendering, UI, host, asset, or Server Function capabilities covered by effront.
Keep reusable parsers and decisions available independently of HTTP middleware.
Prefer stricter, documented security semantics to byte-for-byte Hono compatibility.

## Repository structure

| Path                           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `src/accepts.ts`               | Standalone content negotiation and request adapters        |
| `src/cacheControl.ts`          | Cache policy parsing and formatting                        |
| `src/conditionalRequest.ts`    | Reusable validators and conditional responses              |
| `src/responseCache.ts`         | Bounded, explicitly configured response caching            |
| `src/csrf.ts`                  | Request-origin and Fetch Metadata policy                   |
| `src/secureHeaders.ts`         | Response security policy                                   |
| `src/*.test.ts`                | Public-entry-point behavior and real Web handler tests     |
| `docs/hono-compatibility.md`   | Complete Hono public import-path disposition and strategy  |
| `docs/upstream-differences.md` | Exact upstream revisions and retained semantic differences |
| `NOTICE`                       | Hono license attribution                                   |
| `tmp/`                         | Ignored temporary sources, receipts, and package consumers |

## Upstream policy

- Keep `origin` pointed at `totto2727-org/effect-http` and `upstream` at `honojs/hono`.
- The Vite library template is the scaffold, not the behavioral upstream.
- Record exact Hono, Effect, and effront comparison commits in `docs/upstream-differences.md`.
- Enumerate every fixed Hono export and expand wildcard exports using the pinned build rules, including nested and type-only modules.
- Compare the concrete import-path set with the compatibility table. Missing, extra, and duplicate paths must all be zero.
- Name a concrete Effect or effront counterpart or state a specific exclusion reason in every row.
- Keep effront's implemented scope distinct from planned features. Do not duplicate its HTML/Flight selection, private response policy, static-file handling, or Server Function origin enforcement.
- Update both maintained comparison documents and the [migration guide](.agents/skills/effect-http/references/hono-to-effect/README.md) whenever adopting Hono changes or changing a feature disposition.
- Run the [inventory checker](.agents/skills/effect-http/references/hono-to-effect/README.md#maintain-the-inventory) against the pinned Hono checkout and effront recipes to verify exact coverage, classifications, and recipe anchors.
- Preserve applicable MIT notices when adapting source.
- Never report all of Effect as lacking a feature merely because it does not have a matching middleware name.

## Development commands

- Bootstrap Node.js 24, pnpm from `packageManager`, and Vite+ before `nix develop`.
- Use `vp install --frozen-lockfile` for an existing lock and `vp install` after dependency changes.
- Use `vp run fix` for formatting and supported lint fixes.
- Use `vp test run src/<module>.test.ts` for focused tests.
- Use `vp run --no-cache ci` for fresh formatting, lint, source types, tests, and package builds.
- Use `vp pm pack --pack-destination tmp` after building to create a real package archive.
- Install the archive in an isolated `tmp/` consumer, compile strict NodeNext imports and invalid-call expectations, and execute its exports.
- Remove temporary TypeScript consumers before whole-project checks because default TypeScript discovery includes `tmp/`.

## Boundaries and safety

- Keep Effect as a peer dependency and development dependency.
- Add no runtime dependencies without a concrete benefit that cannot reasonably be supplied by Effect or Web standards.
- Compose policy logic with Effect's collection, string, numeric, parsing, and HTTP APIs instead of native method chains or mutable loop accumulators.
- Use `Result.Result` for parsing outcomes, `Data.TaggedError` for custom errors, and Effect constructors for tagged values. Do not handwrite result unions or `_tag` fields.
- Use `Predicate.isNullish`, `Predicate.isNotNullish`, and `Option.fromNullishOr` for missing values. Do not distinguish `null` from `undefined` without a domain requirement.
- Use Effect `Record` operations to construct and access dictionaries, including externally supplied keys. Do not add custom prototype conversion helpers.
- Keep shared mutable state in `Ref`. Keep pure parsers and decisions synchronous with `Result` or `Option`, rather than wrapping them in an unnecessary Effect.
- Preserve error and environment types through middleware. Provide runtime service implementations at the application boundary. Do not call `Effect.provide` with a concrete implementation inside middleware.
- Delegate URL parsing to `Schema.URLFromString` and request URL resolution to `HttpServerRequest.toURL`. Do not implement URL parsers, authority extraction, or manual request URL concatenation. Keep CSRF-specific restrictions separate from parsing.
- Keep external parsing failures explicit and never turn malformed input into a permissive match.
- Do not buffer arbitrary streams to hash or cache them.
- Do not cache authenticated or cookie-bearing requests by default.
- Keep cache capacity, lifetime, body limits, variants, and invalidation explicit.
- Test observable HTTP responses, negative security cases, and direct helper use through the individual public modules.
- Use camelCase filenames and publish only the six explicit module subpaths. Do not add `src/index.ts` or a root barrel export.
- Define format, length, and numeric value constraints as named Schemas. Decode them at boundaries and retain Schema-derived validated types internally. Keep decision logic separate from value constraints.
- A wrapped cause must be required. Represent failures without a cause as a distinct error, not an optional cause field.
- Follow `README_TEMPLATE.md` from the Vite+ library scaffold. Give each module one concise example of its most common use, not an exhaustive demonstration of every exported function.
- Keep Usage focused on a small runnable server with a few composed middleware, rather than a single utility call or an exhaustive application. Keep individual API examples limited to route registration and the relevant middleware. When middleware requires a runtime service, include `HttpRouter.serve` and provide the implementation with the server layer at startup. Use `HttpRouter.route` and `HttpRouter.addAll` consistently. Apply middleware directly to single-route handlers. Use `Layer.provide(middleware.layer)` to share a policy across a group of routes. Do not alternate with global middleware and `Layer.mergeAll` unless a demonstrated global requirement needs them. Refer to the application's existing Effect handlers in those individual examples instead of repeating request probes, storage setup, and unrelated validation.
- Initialize shared state in the application layer. Keep runtime execution at the entry point rather than calling `Effect.runPromise` during route or middleware setup.
- Demonstrate middleware on real `HttpRouter` routes with request decoding or application state, not prebuilt responses wrapped in `Effect.succeed`. Exercise rejection paths, cache variants, and invalidation through actual requests.
- Prefer `Effect.gen` with `yield*` for sequential work in examples. Reserve `pipe` for middleware, error policies, and layer composition instead of chaining `map` or `flatMap` for application steps.
- Compose `Result` and `Option` with their combinators or Effect conversions in examples. Do not use throwing extraction to conceal parse errors or no-match outcomes.
- Do not add helper APIs solely to expose internals to tests.

## Template toolchain

- Keep Node.js, pnpm, and Vite+ from the template.
- Keep the 24-hour `minimumReleaseAge: 1440` and `minimumReleaseAgeStrict: true` without exclusions.
- Preserve the Vite+ catalog and official Vite/Vitest overrides from the template.
- Use Vite+ for formatting, lint, type checking, tests, and `vp pack` with declarations.
- Keep all formatter defaults, including no semicolons, single quotes, width 120, and preserved Markdown wrapping.
- Derive formatter/linter ignore patterns from `.gitignore` using `@totto2727/gitignore-patterns`.
- Keep the Nix shell limited to nixfmt and the existing externally supplied Vite+ hook.
- Do not add a CLI, `CLAUDE.md`, `package.nix`, or a Nix build output.
- Keep all shared `totto2727-org/monorepo` action references on `@main`.
- Keep inherited CI and publication workflows unchanged unless a demonstrated project requirement needs a change.
- Publication runs on pushes to `main`, including merges. Do not add tag or release triggers.
- Publication CI is explicitly enabled in `publish.yml`, and the manifest is publishable. Before merging publication changes to `main`, require the owner's confirmation of npm trusted publishing for `totto2727-org/effect-http` and workflow filename `publish.yml`, with staging-only permissions when available and no environment unless a matching protected job environment is configured. The shared publisher stages versions; the owner reviews and approves them with 2FA before live publication. Never stage or approve merely to test CI.
- Protect `main` and merge validated changes to trigger publication. Tag pushes do not publish. Never merge or publish merely to test CI.
- Keep the hook-free `ci` Nix shell for setup, building, and the shared publish action so Nix setup does not run `vp config` before Vite+ is installed.
- Enabling CI is not registry authorization or a release. If registry linking needs an initial publication, the owner must bootstrap it manually.
- Never add long-lived npm tokens or publish as part of a coding task without authorization.

_This AGENTS.md was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [AGENTS template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/agents/template.md)._
