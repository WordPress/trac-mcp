# Testing

## Automated checks

Run the complete gate:

```bash
pnpm check
```

This includes:

1. TypeScript type checking.
2. Biome formatting and linting.
3. Vitest parser, pagination, validation, and MCP transport tests.
4. A Cloudflare Worker dry-run build.

Tests mock Trac responses. They should not depend on Trac availability or mutable ticket content.

## Manual smoke test

Start the Worker with `pnpm dev`, then use harmless public ticket and changeset IDs.

1. Confirm `/health` returns `200 OK` and `/` renders the landing page.
2. Send `OPTIONS /mcp`; expect `204` and CORS headers.
3. Initialize `/mcp`, send `ping`, and list tools.
4. Exercise each standard tool:
   - Search a keyword and a structured filter.
   - Read ticket `65739` with and without comments.
   - Read ticket `65808` and confirm its linked pull request data is present.
   - Read ticket `65793` and confirm attachments are separate from comments.
   - Read ticket `62358` and confirm changesets are separate from comments.
   - Read changeset `58504` with and without its diff.
   - Read one day of timeline activity.
   - List components and milestones.
5. Check search page 1 and a page beyond the final result; the latter should return an empty page.
6. Initialize `/mcp/chatgpt`, then search a keyword, ticket `65739`, and changeset `r58504`.
7. Send invalid arguments and confirm the response is a JSON-RPC invalid-params error.

Do not paste private ticket data or credentials into fixtures. If live checks fail, distinguish a
Trac response change from Worker behavior before changing a parser.

## Before deployment

Run `pnpm check`, complete the manual smoke test, review the Worker dry-run output, and confirm the
intended Cloudflare environment. Deployment is a separate, maintainer-approved action.
