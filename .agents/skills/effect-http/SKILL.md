---
name: effect-http
description: Migrate Hono import paths to Effect 4 or use @totto2727/effect-http to negotiate content, cache public responses, apply HTTP preconditions, or protect standalone Effect HTTP routes with CSRF and security headers.
---

# Standalone HTTP policies for Effect

Import the public subpath for the policy you need, not the package root.
Choose the pure helper when the application already has headers or a response, and the middleware when an Effect route owns the request.

- [Negotiate a representation](references/standalone-policies.md#accept-parsing-and-negotiation) and distinguish invalid input from a valid request with no acceptable offer.
- [Set cache headers or reuse public responses](references/standalone-policies.md#cache-policy-and-response-storage) with explicit variants and invalidation.
- [Evaluate request preconditions](references/standalone-policies.md#validators-and-preconditions) before a write, or apply validators to a read response.
- [Reject unsafe cross-origin requests and set security headers](references/standalone-policies.md#csrf-and-security-headers), including headers on denied responses.
- [Compose conditional handling with compression](references/standalone-policies.md#order-and-service-ownership) and provide runtime services at startup.

Leave routing and static-file service to Effect, and rendering, Flight, and Server Functions to the application framework.
For a Hono migration, start with the [migration guide](references/hono-to-effect/README.md) and its [complete import-path map](references/hono-to-effect/import-paths.md).
