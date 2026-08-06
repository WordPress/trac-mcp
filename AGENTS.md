# Contributor guide

## Purpose

This repository provides a read-only MCP server for public WordPress Core Trac data. Preserve that
trust boundary: no Trac writes, credentials, user-selected upstream hosts, or unbounded inputs.

## Work locally

Use Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm dev
pnpm check
```

`pnpm check` is the required pre-PR gate. It runs TypeScript, Biome, Vitest, and a Cloudflare Worker
dry-run build for both environments. CI runs the same command on every pull request, so run it
locally first rather than using CI as the first check.

Green CI does not mean the feature works: every automated test mocks Trac. Follow `docs/testing.md`
when a change affects live Trac parsing or MCP transport, and see `tests/AGENTS.md` for how the
automated and manual layers divide the work.

## Change safely

- Keep advertised JSON schemas and Zod runtime schemas aligned.
- Add or update tests for parser, protocol, routing, and pagination behavior.
- Treat Trac responses as untrusted input.
- Keep upstream requests on `core.trac.wordpress.org` and the official linked-PR endpoint at
  `api.wordpress.org/dotorg/trac/pr/`.
- Return upstream failures as MCP tool errors.
- Update README and manual checks when behavior changes.
- Do not deploy without explicit maintainer approval.
