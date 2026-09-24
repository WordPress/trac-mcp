# WordPress Trac MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server for the WordPress.org
Trac instances, starting with [WordPress Core Trac](https://core.trac.wordpress.org/). It runs as a
Cloudflare Worker and uses Trac's public HTML, CSV, RSS, and diff endpoints.

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

## Trac instances

Each Trac instance has its own endpoint. `/mcp` and `/mcp/chatgpt` serve Core.

| Trac | Standard MCP | Search/fetch compatibility |
| --- | --- | --- |
| [WordPress Core](https://core.trac.wordpress.org/) | `/mcp` | `/mcp/chatgpt` |
| [Making WordPress.org](https://meta.trac.wordpress.org/) | `/mcp/meta` | `/mcp/meta/chatgpt` |
| [Themes](https://themes.trac.wordpress.org/) | `/mcp/themes` | `/mcp/themes/chatgpt` |
| [Plugins](https://plugins.trac.wordpress.org/) | `/mcp/plugins` | `/mcp/plugins/chatgpt` |
| [bbPress](https://bbpress.trac.wordpress.org/) | `/mcp/bbpress` | `/mcp/bbpress/chatgpt` |
| [BuddyPress](https://buddypress.trac.wordpress.org/) | `/mcp/buddypress` | `/mcp/buddypress/chatgpt` |
| [GlotPress](https://glotpress.trac.wordpress.org/) | `/mcp/glotpress` | `/mcp/glotpress/chatgpt` |
| [Google Summer of Code](https://gsoc.trac.wordpress.org/) | `/mcp/gsoc` | `/mcp/gsoc/chatgpt` |

The table is a discovery aid rather than an allowlist. Any `<slug>.trac.wordpress.org` resolves at
`/mcp/<slug>`, so a Trac added later needs no change here. An instance is bound to the connection
rather than chosen per tool call, so a client cannot read the wrong Trac by mistake.

Instances configure different fields. Themes has no components, and only some instances have
severities. `getTracInfo` reports a field the instance does not configure as unavailable instead of
failing. Ticket fields behave the same way: `focuses` exists only on Core and comes back empty
elsewhere.

Filtering is stricter, because Trac answers a filter on a field it does not configure with the
unfiltered result set rather than an error, and that reads as a real match count. `searchTickets`
rejects such a filter and names the fields the instance does have. This covers both the separate
arguments and the expressions inside `query`.

Connect to one instance per client entry. Use several entries to read several Tracs.

## Tools

The standard `/mcp` endpoint provides:

| Tool | Purpose |
| --- | --- |
| `searchTickets` | Search by keywords, ticket number, or structured filters |
| `getTicket` | Read a ticket, its attachments, changesets, human discussion, and linked pull requests. `commentLimit` returns the newest comments, up to 500, and the result reports `totalComments` and `returnedComments` |
| `getChangeset` | Read a changeset and an optional truncated diff |
| `getTimeline` | Read Trac activity for recent days or a historical date range, with author filtering and day-granular coverage |
| `getTracInfo` | List components, milestones, priorities, severities, types, or statuses |

`getTicket` leaves bot comments, cc-only changes, and entries with neither a change nor text out of
`comments` and lists each one under `omittedComments` with its ID, author, and reason (`bot`, `cc`,
or `empty`), so a gap in the comment numbering is explained rather than mistaken for truncation.
Every other field change a person makes is reported in `changes` with its values, including keyword
edits and description edits with their diff link.

`getChangeset` expects the numeric `revision` argument, not `rev`:

```json
{
  "revision": 58504,
  "includeDiff": false
}
```

The `/mcp/chatgpt` compatibility endpoint provides `search` and `fetch`. Use a bare number for a
ticket and an `r` prefix for a changeset: `65739` and `r58504`.

No tool takes a Trac instance argument. The endpoint you connect to decides which Trac the tools
read.

Ticket and changeset text is plain text with one exception: links are kept as `<a href="...">`
with an absolute URL, because a comment that points at a pull request or another ticket loses its
point without one. Relative Trac links resolve against the instance you connected to.

### Search filters

`searchTickets` accepts plain keywords, ticket numbers, or filter expressions joined with `&`.
Plain keywords match the ticket summary only; use `description~=text` to search ticket bodies.

```json
{
  "query": "milestone=6.9&status=closed&resolution=fixed",
  "limit": 50,
  "page": 2
}
```

Expressions can name `summary`, `description`, `owner`, `reporter`, `type`, `status`, `priority`,
`milestone`, `component`, `version`, `severity`, `resolution`, `keywords`, `cc`, or `focuses`, and
take four operators: `=` exact, `~=` contains, `!=` not equal, and `!~=` does not contain. Repeat
a field to OR its values (`status=new&status=assigned`), with the same operator each time. Add `order=<column>` and `desc=1` to
sort, for example `component=Editor&status!=closed&order=changetime&desc=1`. Sortable columns are
the fields above plus `time` and `changetime`. Field values differ by instance: `getTracInfo`
lists the complete components, milestones, priorities, severities, types, and statuses each one configures, in Trac's order. Milestones include open and closed groups as one flat list.

It also accepts `status`, `component`, `milestone`, and `resolution` as separate arguments. Each
is an exact match on one value and overrides the same field in `query`; the expression form is
the one to use for substring, OR, or negation. Results include pagination metadata.

### Timeline ranges, authors, and coverage

`getTimeline` reads the last `days` days (default 7, max 30) or an explicit `from`/`to` date range. Historical dates start at `2005-01-01`, the start of the verified WordPress Core Trac timeline (younger instances have no events before their own first day), and may span at most 90 days per request because the upstream timeline caps its lookback. Dates are inclusive UTC calendar days: `days` counts whole days ending today, `from` on its own ends at today, and `to` on its own covers the seven days ending at `to`. A `to` in the future is rejected, and `days` cannot be combined with `from`/`to`:

```json
{
  "from": "2005-01-01",
  "to": "2005-01-31",
  "author": "saxmatt",
  "limit": 20
}
```

`author` takes one Trac username or a list of up to ten. The server filters by author before the
event limit applies, so a contributor's events stay complete even inside a busy window.

Calls that use only `days` and `limit` keep the original recent-activity contract: `limit` is the maximum number of upstream events, and the response contains `results`, `totalEvents`, `daysBack`, and `timelineUrl`.

For a date-range or author-filtered call, `limit` (1 to 100, default 20) is advisory. A response covers whole calendar days: results are rounded down to a day boundary, and the newest complete day of the window comes back in full even when it holds more events than `limit`.

Each coverage response lists events newest first in `results` and reports `requested`, the window that was
asked for, and `covered`, the part of it this response covers completely. `complete` says whether
the response covered all of it. When it is `false`, `continueWith` is a ready-made arguments object
for the remainder: it preserves the effective `limit` and the accepted `author` input when present,
so send it back to `getTimeline` unchanged and repeat until a response reports `complete` as `true`,
or until a response arrives without a `continueWith`. A continuation window always ends on a day already past, so walking one cannot produce gaps or duplicates. `note` states the coverage in plain language, and coverage that includes today is accurate as of the request. If one day fills the 500-event upstream fetch, that incomplete day is not included in `covered`: `covered` is `null`, `complete` is `false`, and `terminalTruncation` states that the tool cannot continue within that day.

[docs/timeline-pagination.md](docs/timeline-pagination.md) records why the timeline reports day
coverage instead of page numbers.

### Tool errors

A failed tool call returns an MCP result with `isError: true`. Its JSON payload carries a
machine-readable `code` alongside the human-readable `error` message. `not_found` errors also name
the `resource` and `id` that were requested:

```json
{
  "code": "not_found",
  "error": "Ticket 99999999 not found",
  "resource": "ticket",
  "id": 99999999
}
```

| `code` | Meaning |
| --- | --- |
| `not_found` | The requested ticket or changeset does not exist |
| `invalid_argument` | An argument passed schema validation but cannot be used, such as an unsupported search filter field |
| `rate_limited` | Trac throttled the request and bounded retries did not clear it |
| `upstream_error` | Trac or a supporting service failed or returned unexpected content |

Codes are stable API surface: branch on `code`, never on `error` wording. An existing code keeps
its meaning and is only removed or renamed with a major version bump, while messages can change
freely. New codes may be added over time, so treat an unrecognized code as `upstream_error`.

Arguments that fail the advertised input schema also return `isError: true`, but as the MCP SDK's
plain-text message beginning `Input validation error:` rather than a JSON payload, so a model can
read it and retry. An unknown tool name is a JSON-RPC `-32602` error.

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
    },
    "wordpress-meta-trac": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev/mcp/meta"
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

Open `http://localhost:8787/` to view the local landing page. See
[docs/local-development.md](docs/local-development.md) for the full browser-preview workflow and
troubleshooting.

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
- The MCP protocol layer is the official TypeScript SDK. Each endpoint serves stateless 2026-07-28
  clients and handshake-era clients (2024-10-07 through 2025-11-25), answering the latter with plain
  JSON. The advertised input schemas are generated from the same Zod schemas that validate calls.
- Tool inputs receive runtime validation before any upstream request.
- Upstream requests stay on `*.trac.wordpress.org` and the official linked-PR endpoint on
  `api.wordpress.org`. The instance slug comes from the URL path, is validated against a strict
  pattern before it reaches a request, and every request is checked against the resolved origin.
- Upstream redirects are never followed. `*.trac.wordpress.org` has wildcard DNS and redirects
  unknown subdomains to Core, so following one would answer for one instance with another's data.
  A redirect that leaves the instance origin is reported as an unknown instance; one that stays on
  it is reported as an upstream failure.
- Transient transport failures, rate limits, server errors, and Trac bot challenges receive bounded
  retries. Permanent 403 and 404 responses return immediately.
- Responses are parsed from public Trac pages and machine-readable formats.
- The Worker keeps no ticket cache or durable state.

## Contribute

Keep tool schemas, runtime validation, tests, and documentation aligned. Run `pnpm check` before
opening a pull request.

## License

GPL-2.0-or-later.
