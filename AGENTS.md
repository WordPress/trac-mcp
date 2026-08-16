# Contributor guide

## Purpose

This repository provides a read-only MCP server for public WordPress.org Trac data. Preserve that trust boundary: no Trac writes, credentials, or unbounded inputs.

The upstream host is derived from a URL path segment, so treat that derivation as security-relevant. A request may only reach `<slug>.trac.wordpress.org` where the slug matches `TRAC_SLUG_PATTERN`, and `fetchTrac` rechecks every URL against the resolved instance origin. Redirects are never followed: the domain has wildcard DNS and sends unknown subdomains to Core, so a followed redirect would silently answer for one instance with another's data.

## Work locally

Use Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm dev
pnpm check
```

For a browser-visible local preview, keep `pnpm dev` running and open `http://localhost:8787/`. Check `http://localhost:8787/health` for `OK`. See `docs/local-development.md` for the full workflow and troubleshooting.

`pnpm check` is the required pre-PR gate. It runs TypeScript, Biome, Vitest, and a Cloudflare Worker dry-run build for both environments. CI runs the same command, so run it locally first rather than using CI as the first check.

Green CI does not mean the feature works: every automated test mocks Trac. Follow `docs/testing.md` when a change affects live Trac parsing or MCP transport, and see `tests/AGENTS.md` for how the automated and manual layers divide the work.

## Change safely

- Keep advertised JSON schemas and Zod runtime schemas aligned.
- Add or update tests for parser, protocol, routing, and pagination behavior.
- Treat Trac responses as untrusted input.
- Keep upstream requests on `*.trac.wordpress.org` and the official linked-PR endpoint at `api.wordpress.org/dotorg/trac/pr/`.
- Take the Trac instance from the endpoint path, never from a tool argument. Binding it to the connection is what stops a client reading the wrong Trac.
- Expect fields to differ between instances. Report a field an instance does not configure as unavailable rather than failing, but keep failing when the page is not a Trac query page at all.
- Return upstream failures as MCP tool errors.
- Update README and manual checks when behavior changes.
- Do not deploy without explicit maintainer approval.
