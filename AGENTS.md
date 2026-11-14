# effect-http

## Purpose and scope

This library supplies missing HTTP negotiation, cache, and security policies for Effect 4.
Do not recreate Hono context, routers, JSX, adapters, or behavior already substantially covered by Effect.
Keep reusable parsers and decisions available independently of HTTP middleware.
Prefer stricter, documented security semantics to byte-for-byte Hono compatibility.

## Repository structure

| Path                           | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `src/index.ts`                 | Public namespace exports                                      |
| `src/Accepts.ts`               | Standalone content negotiation and request adapters           |
| `src/CacheControl.ts`          | Cache policy parsing and formatting                           |
| `src/ConditionalRequest.ts`    | Reusable validators and conditional responses                 |
| `src/ResponseCache.ts`         | Bounded, explicitly configured response caching               |
| `src/Csrf.ts`                  | Request-origin and Fetch Metadata policy                      |
| `src/SecureHeaders.ts`         | Response security policy                                      |
| `src/*.test.ts`                | Public-entry-point behavior and real Web handler tests        |
| `docs/hono-compatibility.md`   | Complete Hono feature disposition and implementation strategy |
| `docs/upstream-differences.md` | Exact upstream revisions and retained semantic differences    |
| `NOTICE`                       | Hono license attribution                                      |
| `tmp/`                         | Ignored temporary sources, receipts, and package consumers    |

## Upstream policy

- Keep `origin` pointed at `totto2727-org/effect-http` and `upstream` at `honojs/hono`.
- The Vite library template is the scaffold, not the behavioral upstream.
- Record the exact Hono comparison commit and Effect comparison commit in `docs/upstream-differences.md`.
- Update both maintained comparison documents whenever adopting Hono changes or changing a feature disposition.
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
- Preserve error and environment types through middleware.
- Keep external parsing failures explicit and never turn malformed input into a permissive match.
- Do not buffer arbitrary streams to hash or cache them.
- Do not cache authenticated or cookie-bearing requests by default.
- Keep cache capacity, lifetime, body limits, variants, and invalidation explicit.
- Test observable HTTP responses, negative security cases, and direct helper use through `src/index.ts`.
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
- Do not replace publication on pushes to `main` with tag or release triggers, and preserve existing tag triggers.
- Keep `private: true` and `publish.yml.disabled` until the owner configures npm trusted publishing for the exact repository and workflow.
- Never add long-lived npm tokens or publish as part of a coding task without authorization.

_This AGENTS.md was generated from the [share-artifact skill](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/SKILL.md) and [AGENTS template](https://raw.githubusercontent.com/totto2727-org/agent/refs/heads/main/plugins/totto2727-coding/skills/share-artifact/agents/template.md)._
