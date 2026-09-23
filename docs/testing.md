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

Mocked tests cannot see the one failure that matters most for multiple instances: `*.trac.wordpress.org` redirects unknown subdomains to Core, so a server that follows redirects answers for the wrong Trac while every mocked test passes. The automated suite pins the guard against that, and step 10 of the smoke test confirms it against the live domain.

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
   - Read seven days of timeline activity. Confirm this call keeps the original `totalEvents` and `daysBack` response contract and that the strict event limit is applied. A short window can legitimately be empty, so judge this on the request succeeding rather than on the count.
   - Read a historical timeline range filtered to one author, using a range from January 2005 so the result cannot come from recent activity, and ask for less than the window holds so the first response cannot be complete. Every event should carry that author with a January 2005 date, `covered` should be a whole-day window inside `requested`, `complete` should be `false`, and `continueWith` should resume on the day before `covered` begins.
   - Walk that range to its end by resending exactly the `continueWith` the server returned, until a response reports `complete` as `true`. The walked windows should tile the requested range with no gap and no overlap, and the walk should terminate. This is the check the page-based smoke test never reached: it promised a final page and never ran one. [smoke-test.md](smoke-test.md) records the event total for that fixture window, which the walk should add up to.
   - List components and milestones.
5. Check search page 1 and a page beyond the final result; the latter should return an empty page.
6. Initialize `/mcp/chatgpt`, then search a keyword, ticket `65739`, and changeset `r58504`.
7. Send invalid arguments and confirm the response is a JSON-RPC invalid-params error.
8. Request ticket `99999999` and changeset `99999999`; confirm each returns a tool error whose payload carries `"code": "not_found"` with the resource and ID named. Search with an unsupported filter field and confirm `"code": "invalid_argument"`.
9. Exercise a non-Core instance at `/mcp/meta` and `/mcp/meta/chatgpt`. Every URL in a result must point at `meta.trac.wordpress.org`; a `core.trac.wordpress.org` URL means the instance was not threaded through.
10. Ask an instance for a field it does not configure, such as severities on `/mcp/meta`. Expect an "are not available" answer rather than a tool error, and confirm Core still returns its populated list.
11. Call a tool on a slug with no Trac behind it, such as `/mcp/xyzzy-nope`. Expect `Unknown or unavailable Trac instance`. Core data here is a security regression: the domain redirects unknown subdomains to Core, so a server that follows redirects fails this check while looking healthy.
12. Filter a search on a field the instance does not configure, such as a component on `/mcp/themes`. Expect a tool error naming the fields that instance does have, and confirm the same filter still succeeds where the field exists. A passing-looking result is the failure here: Trac answers an unconfigured filter with the whole ticket set and a matching count.
13. Send a malformed instance path, such as `/mcp/`, `/mcp/Meta`, `/mcp/meta/`, `/mcp/meta/tools`, or `/mcp/chatgpt/chatgpt`. Each returns `404`. Slugs are lowercase, and `chatgpt` is a route keyword rather than an instance.

Do not paste private ticket data or credentials into fixtures. If live checks fail, distinguish a Trac response change from Worker behavior before changing a parser.

## Before deployment

Run `pnpm check`, complete the manual smoke test, review the Worker dry-run output, and confirm the intended Cloudflare environment. Deployment is a separate, maintainer-approved action.
