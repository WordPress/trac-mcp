# Tests

No test code lives in this directory. It is a signpost.

**Automated tests** live next to the source they cover, as `src/*.test.ts`. Vitest discovers them by filename, so a new suite goes beside its module rather than here. CI runs `pnpm check` on every pull request, which is the same command below.

```bash
pnpm test    # Vitest only
pnpm check   # the required pre-PR gate: types, lint, tests, dry-run builds
```

**Manual checks** live in `docs/`, and cover what CI cannot: a stale deployment, upstream Trac markup changes, and transport behavior against a real server.

- [`docs/testing.md`](../docs/testing.md) is the canonical checklist and explains what the gate covers.
- [`docs/smoke-test.md`](../docs/smoke-test.md) is the same list as paste-ready commands with expected results, for checking a running server.

See [`AGENTS.md`](AGENTS.md) for how the two layers divide the work.
