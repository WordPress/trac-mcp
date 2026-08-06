# WordPress Trac MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for
[WordPress Core Trac](https://core.trac.wordpress.org/). It runs as a Cloudflare Worker and uses
Trac's public HTML, CSV, RSS, and diff endpoints.

Live servers:

Production:

- Standard MCP: `https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev/mcp`
- Search/fetch compatibility: `https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev/mcp/chatgpt`
- Health check: `https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev/health`

Staging:

- Standard MCP: `https://mcp-server-wporg-trac-staging.a8c-aiops.workers.dev/mcp`
- Search/fetch compatibility: `https://mcp-server-wporg-trac-staging.a8c-aiops.workers.dev/mcp/chatgpt`
- Health check: `https://mcp-server-wporg-trac-staging.a8c-aiops.workers.dev/health`

The former staging deployment at `https://mcp-server-wporg-trac-staging.a8cai.workers.dev` is
deprecated and runs older code. Its `a8cai.workers.dev` subdomain differs from the active staging
deployment's `a8c-aiops.workers.dev` subdomain.

## Tools

The standard `/mcp` endpoint provides:

| Tool | Purpose |
| --- | --- |
| `searchTickets` | Search by keywords, ticket number, or structured filters |
| `getTicket` | Read a ticket, its metadata, and recent comments |
| `getChangeset` | Read a changeset and an optional truncated diff |
| `getTimeline` | Read recent Trac activity |
| `getTracInfo` | List components, milestones, priorities, severities, types, or statuses |

`getChangeset` expects the numeric `revision` argument, not `rev`:

```json
{
  "revision": 58504,
  "includeDiff": false
}
```

The `/mcp/chatgpt` compatibility endpoint provides `search` and `fetch`. Use a bare number for a
ticket and an `r` prefix for a changeset: `65739` and `r58504`.

### Search filters

`searchTickets` accepts plain keywords, ticket numbers, or filter expressions joined with `&`:

```json
{
  "query": "milestone=6.9&status=closed&resolution=fixed",
  "limit": 50,
  "page": 2
}
```

It also accepts `status`, `component`, `milestone`, and `resolution` as separate arguments. A
separate argument overrides the same field in `query`. Results include pagination metadata.

## Connect

Remote-capable MCP clients can connect directly to the standard endpoint. Clients that need a local
bridge can use `mcp-remote`:

```json
{
  "mcpServers": {
    "wordpress-trac": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev/mcp"
      ]
    }
  }
}
```

For ChatGPT, add the compatibility endpoint as a custom app. See
[OpenAI's current MCP help](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
because product labels and setup steps change.

After changing a configured server URL, reconnect the MCP server or restart the client once. Future
deployments to the same URL do not require a client configuration change.

## Develop

Requirements: Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm dev
```

Run the complete local quality gate:

```bash
pnpm check
```

This runs TypeScript, Biome, Vitest, and a Cloudflare Worker dry-run build. See
[docs/testing.md](docs/testing.md) for manual protocol and live-data checks.

Deployment requires a configured Cloudflare account:

```bash
# Staging
pnpm run deploy

# Production
pnpm run deploy:production
```

## Design and safety

- The server is read-only and has no Trac credentials.
- Tool inputs receive runtime validation before any upstream request.
- Upstream requests use the fixed `core.trac.wordpress.org` host.
- Responses are parsed from public Trac pages and machine-readable formats.
- The Worker keeps no ticket cache or durable state.

## Contribute

Keep tool schemas, runtime validation, tests, and documentation aligned. Run `pnpm check` before
opening a pull request.

## License

GPL-2.0-or-later.
