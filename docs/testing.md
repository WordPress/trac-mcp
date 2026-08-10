# Testing

## Automated checks

Run the complete gate:

```bash
pnpm check
```

This includes:

1. TypeScript type checking.
2. Biome formatting and linting.
3. Vitest parser, pagination, timeline coverage, validation, and MCP transport tests.
4. Cloudflare Worker dry-run builds for both the default and production environments.

Tests mock Trac responses. They should not depend on Trac availability or mutable ticket content.

## Manual smoke test

Start the Worker by following [local-development.md](local-development.md), then use harmless public ticket and changeset IDs. See [smoke-test.md](smoke-test.md) for the same list as runnable commands with expected results.

1. Confirm `/health` returns `200 OK` and `/` renders the landing page.
2. Send `OPTIONS /mcp`; expect `204` and CORS headers.
3. Initialize `/mcp`, send `ping`, and list tools.
4. Exercise each standard tool:
   - Search a keyword and a structured filter.
   - Read ticket `65739` with and without comments.
   - Read ticket `65808` and confirm its linked pull request data is present.
   - Read ticket `65793`; confirm linked pull request data remains available with no reviews and attachments are separate from comments.
   - Read ticket `62358`; confirm linked pull request data remains available with no checks and changesets are separate from comments.
   - Read changeset `58504` with and without its diff.
   - Read seven days of timeline activity. A short window can legitimately be empty, so judge this on the request succeeding rather than on the count.
   - Read a historical timeline range filtered to one author, using a range from January 2005 so the result cannot come from recent activity, and ask for less than the window holds so the first response cannot be complete. Every event should carry that author with a January 2005 date, `covered` should be a whole-day window inside `requested`, `complete` should be `false`, and `continueWith` should resume on the day before `covered` begins.
   - Walk that range to its end by resending exactly the `continueWith` the server returned, until a response reports `complete` as `true`. The walked windows should tile the requested range with no gap and no overlap, and the walk should terminate. This is the check the page-based smoke test never reached: it promised a final page and never ran one. [smoke-test.md](smoke-test.md) records the event total for that fixture window, which the walk should add up to.
   - List components and milestones.
5. Check search page 1 and a page beyond the final result; the latter should return an empty page.
6. Initialize `/mcp/chatgpt`, then search a keyword, ticket `65739`, and changeset `r58504`.
7. Send invalid arguments and confirm the response is a JSON-RPC invalid-params error.

Do not paste private ticket data or credentials into fixtures. If live checks fail, distinguish a Trac response change from Worker behavior before changing a parser.

## Before deployment

Run `pnpm check`, complete the manual smoke test, review the Worker dry-run output, and confirm the intended Cloudflare environment. Deployment is a separate, maintainer-approved action.
