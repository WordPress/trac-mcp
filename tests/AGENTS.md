# Contributor guide: tests

## How testing here fits together

Two layers, and they catch different failures.

| Layer | Command | Runs in CI | Catches |
| --- | --- | --- | --- |
| Automated | `pnpm check` | Yes, on every PR and push to `main` | Type errors, lint and format drift, parser and protocol regressions against mocked responses, a broken Worker build in either environment |
| Manual smoke test | `docs/smoke-test.md` | No | A stale deployment, upstream Trac markup changes, transport behavior against a real server |

CI (`.github/workflows/ci.yml`) runs the same project check and nothing else, so run it locally before pushing rather than using CI as the first check. A local pass is a good signal, not a guarantee. CI installs from a frozen lockfile on Linux with Node 22 and depends on GitHub services. It can still fail on environment or dependency differences a local run never sees.

**Green CI does not mean the feature works.** Every automated test mocks Trac, by design, so the suite passes whether or not Trac still returns what the parser expects and whether or not the deployed Worker matches `main`. Only the smoke test answers those. Run it against `pnpm dev` before opening a PR that touches Trac parsing or MCP transport, and against the deployment after it ships.

## Where tests go

Put unit tests beside the code they cover, as `src/*.test.ts`. Vitest discovers them by filename. Do not add test code to this directory; splitting suites across two roots makes coverage hard to reason about.

## Writing tests

- Mock Trac responses. A test that reaches `core.trac.wordpress.org` fails on a network blip or when someone edits a ticket, and that failure says nothing about our code.
- Cover parser, protocol, routing, and pagination behavior. Those are where regressions land.
- When you change a tool's arguments, assert on both the advertised JSON schema and the Zod runtime schema. They are separate declarations and drift silently, and the drift is invisible until a client sends a request.
- Treat every Trac response in a fixture as untrusted input, the same as production code does.
- Never put private ticket data or credentials in a fixture.

## Before you push

`pnpm install --frozen-lockfile` is what CI uses, so commit the lockfile whenever dependencies change. Node 22 or later is required; older versions emit an engine warning and are not what CI runs.
