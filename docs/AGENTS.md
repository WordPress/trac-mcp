# Contributor guide: docs

## What lives here

- `testing.md` is the canonical description of how this repository is tested: the automated gate CI runs, the manual smoke test, and what to do before a deployment.
- `smoke-test.md` is that manual checklist as paste-ready commands with expected results.
- `local-development.md` explains how to run the Worker locally and verify its browser-visible routes.

`testing.md` and `smoke-test.md` are one document split by audience. `testing.md` explains the shape, `smoke-test.md` is what you actually run. Change one and check the other still agrees.

## Verify before you document

Every command in these files has been run against a live server. Keep it that way. Do not document a request payload, an argument name, or an expected response you have not executed. Do not infer one from the source either: the advertised JSON schema and the Zod runtime schema are separate declarations, and either can drift from what the server accepts.

The argument names in `smoke-test.md` exist because guessing them produced runtime errors. `getTicket` takes `id`, `getTracInfo` takes `type`, and `getChangeset` takes `revision`. Verify against a running server with `tools/list`, not against memory.

## When behavior changes

CI runs `pnpm check` and cannot tell whether the docs still match the server. That check is yours.

- Changing a tool's arguments or output means updating `smoke-test.md` and the README in the same pull request.
- Adding a fixture ticket to `smoke-test.md` means recording in the fixture table why it is there. A check that starts failing later can then be judged against what it was meant to cover.
- Fixtures are real public tickets and their content can move. A ticket that gains its first attachment can turn a passing check into a failing one, which is a stale fixture rather than a regression.

## House style

Sentence case headings. Do not hard wrap prose; let each paragraph run as one line and wrap where it is read. Say what a reader should see, not just what to type. Never include private ticket data, credentials, or local file paths.
