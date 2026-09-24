# Smoke test

Runnable version of the manual smoke test in [testing.md](testing.md). Every step is a command you can paste, with the result to look for. Written so an agent or a person can work straight down the list without inventing payloads.

Run this against a local dev server before opening a PR that touches Trac parsing or MCP transport, and against a deployment after it goes out.

## Set up

Pick a target and export it once. Everything below reads `$BASE`.

```bash
# Local, after `pnpm dev` in another terminal:
export BASE=http://127.0.0.1:8787

# Or a deployment:
export BASE=https://wordpress-trac-mcp-server-prod.a8c-aiops.workers.dev
```

Tool results arrive as JSON encoded inside a text block, so raw `grep` on the response fights the escaping. Paste these two helpers first:

```bash
rpc() { curl -s -m 60 -X POST "$BASE$1" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d "$2"; }

call() { rpc "$1" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'] if 'error' not in d else 'ERROR '+json.dumps(d['error']))"; }
```

The 60 second timeout is deliberate. The server retries transient Trac failures with 2, 4, and 8 second backoff, and `getChangeset` fetches the changeset page and its diff in sequence. A request that eventually succeeds can spend about 28 seconds waiting before any network time. A shorter timeout kills valid retries and reads as a server fault.

Argument names are easy to guess wrong. The real ones:

| Tool | Required | Optional |
| --- | --- | --- |
| `searchTickets` | none | `query`, `limit`, `page`, `status`, `component`, `milestone`, `resolution` |
| `getTicket` | `id` | `includeComments`, `commentLimit` |
| `getChangeset` | `revision` | `includeDiff`, `diffLimit` |
| `getTimeline` | none | `days`, `limit`, `from`, `to`, `author` |
| `getTracInfo` | `type` | none |

`getTicket` takes `id`, not `ticketId`. `getTracInfo` takes `type`, not `infoType`. `getChangeset` takes `revision`, not `rev`.

## 1. Transport surface

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"          # 200
curl -s "$BASE/" | head -5                                        # HTML landing page
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "$BASE/mcp"  # 204
curl -s -D - -o /dev/null -X OPTIONS "$BASE/mcp" | grep -i access-control
```

The CORS preflight must return `access-control-allow-origin`, `-methods`, and `-headers`.

## 2. Protocol

```bash
rpc /mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
rpc /mcp '{"jsonrpc":"2.0","id":1,"method":"ping"}'
rpc /mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expect `serverInfo` naming the server, `"result":{}` for the ping, and all five tools advertised: `searchTickets`, `getTicket`, `getChangeset`, `getTimeline`, `getTracInfo`.

The server negotiates the handshake version the client asks for, here `2025-06-18`, up to `2025-11-25`.

Clients on the stateless 2026-07-28 revision skip the handshake. [`mcp-explorer`](https://github.com/simonw/mcp-explorer) exercises both eras in one run:

```bash
uvx mcp-explorer doctor "$BASE/mcp"
uvx mcp-explorer doctor "$BASE/mcp/meta/chatgpt"
```

Expect `Result: healthy`, with the stateless mode reporting protocol version `2026-07-28` and the legacy mode reporting `2025-11-25`, and 5 tools on `/mcp` and 2 on the ChatGPT endpoint.

## 3. Tools

Use these public fixtures only. Each one is here because it covers a distinct parsing path.

| Fixture | Covers |
| --- | --- |
| `65739` | Ordinary ticket, with and without comments |
| `65808` | Linked pull request data present |
| `65793` | Linked PR with no reviews; attachments kept separate from comments |
| `62358` | Linked PR with no checks; changesets kept separate from comments |
| `51407` | Escaped markup in a description; the text `<script>` inside a code span |
| `59446` | Links in a description and in comments; comments 1 and 7 are bot comments listed under `omittedComments` |
| `r58504` | Changeset, with and without its diff |
| `r62723` | Escaped markup in a changeset message; the same `<script>` text |
| January 2005, author `saxmatt` | Timeline history that cannot come from recent activity, and a window large enough to force a continuation |
| `99999999` | Nonexistent ticket and revision; the `not_found` tool error path |

```bash
call /mcp searchTickets '{"query":"editor","limit":2}'
call /mcp searchTickets '{"query":"milestone=6.9&status=closed","limit":2}'
call /mcp getTicket '{"id":65739,"includeComments":false}'
call /mcp getTicket '{"id":65739,"includeComments":true}'
call /mcp getTicket '{"id":65808}'
call /mcp getTicket '{"id":65793}'
call /mcp getTicket '{"id":62358}'
call /mcp getTicket '{"id":51407,"includeComments":false}'
call /mcp getTicket '{"id":59446,"includeComments":true,"commentLimit":20}'
call /mcp getChangeset '{"revision":58504,"includeDiff":false}'
call /mcp getChangeset '{"revision":58504,"includeDiff":true,"diffLimit":500}'
call /mcp getChangeset '{"revision":62723,"includeDiff":false}'
call /mcp getTimeline '{"days":7,"limit":5}'
call /mcp getTimeline '{"from":"2005-01-01","to":"2005-01-31","author":"saxmatt","limit":20}'
call /mcp getTracInfo '{"type":"components"}'
call /mcp getTracInfo '{"type":"milestones"}'
```

What to look for:

- Keyword search returns a populated `results` array.
- The structured filter returns tickets whose `metadata.milestone` is `6.9` and `status` is `closed`. A filter query that comes back empty while the keyword search works points at CSV parsing, not at connectivity.
- `getTicket` returns `id`, `title`, `text`, `url`, and `metadata`. With comments requested, `metadata` carries `comments`, `returnedComments`, and `totalComments`.
- Tickets `65808`, `65793`, and `62358` each carry `metadata.linkedPullRequests`. `65793` also carries `metadata.attachments`, and `62358` also carries `metadata.changesets`, neither of them folded into the comment list.
- `getChangeset` returns the revision, author, date, message, and file list. With `includeDiff`, the text includes diff hunks and respects `diffLimit`.
- Ticket `59446` keeps its links as `<a href="...">` with absolute URLs. Its description links to an "existing PR" on GitHub and to an "example plugin". Text without the surrounding tag means links are being stripped again.
- Ticket `51407` and changeset `r62723` both contain the literal text `<script>`, written on Trac inside a code span. Trac escapes it once for HTML and, in RSS, once more for XML. A missing `<script>` means the parser decoded a level too many before stripping tags and deleted the result.
- `getTimeline` returns recent events, and `getTracInfo` returns the requested vocabulary. A seven day window is used because a quiet day can legitimately produce no events. An empty list is a valid answer for any short window, so judge this check on the request succeeding rather than on the count.
- The recent `getTimeline` call keeps the original response shape: it returns `results`, `totalEvents`, `daysBack`, and `timelineUrl`, and `totalEvents` is at most the requested `limit` of 5. A seven day window is used because a quiet day can legitimately produce no events. An empty list is a valid answer for any short window, so judge this check on the request succeeding rather than on the count. `getTracInfo` returns the requested vocabulary.
- The historical `getTimeline` call proves the server answers from the requested range rather than from recent activity: every event carries `saxmatt` as `metadata.author` with a January 2005 date. January 2005 is immutable history, so this call should never legitimately come back empty.
- That same call shows the coverage envelope. `requested` is the window that was asked for, `covered` is a whole-day window inside it, `complete` is `false` because the month holds more events than `limit`, and `continueWith.to` is the day before `covered.from`. `continueWith` also preserves `author` as `saxmatt` and `limit` as `20`, so it is the complete next request. `returned` counts the events in `results`, `authors` lists `saxmatt`, and `note` describes the coverage in words. No `page`, `pageSize`, `hasMore`, `nextPage`, `totalEvents`, `returnedEvents`, or `daysBack` field should appear.

## 4. Timeline coverage walk

A date-range or author-filtered response covers whole days, not a page, so the way to reach the end of a range is to resend the `continueWith` window the server hands back until a response reports `complete` as `true`. Paste this helper, which does exactly that and keeps a running total:

```bash
walk_timeline() {
  local lim="${1:-20}" args total=0 steps=0 returned line next
  args="{\"from\":\"2005-01-01\",\"to\":\"2005-01-31\",\"author\":\"saxmatt\",\"limit\":$lim}"
  while [ -n "$args" ] && [ "$steps" -lt 40 ]; do
    { IFS= read -r returned; IFS= read -r line; IFS= read -r next; } < <(call /mcp getTimeline "$args" | python3 -c "
import json, sys
d = json.load(sys.stdin); r, c, n = d['requested'], d['covered'], d.get('continueWith')
print(d['returned'])
print(f\"requested {r['from']}..{r['to']}  covered {c['from']}..{c['to']}  returned {d['returned']}  complete {d['complete']}\")
print(json.dumps(n) if n else '')")
    [ -n "$returned" ] || { echo 'walk stopped: response was not a timeline result'; return 1; }
    total=$((total + returned)); steps=$((steps + 1)); echo "$line"; args="$next"
  done
  echo "steps: $steps  events: $total"
}

walk_timeline      # limit 20
walk_timeline 5    # smaller windows, more steps, same events
```

The helper sends nothing of its own after the first call: each later request is exactly the `continueWith` object the server returned, including its `author` filter and effective `limit`.

What to look for:

- One line per step, ending with a step whose `complete` is `True` and which carries no `continueWith`. Termination is the point of this check. The old page-based smoke test never ran a final page, so it never tested that a walk ends. A walk can also stop with `complete` false and `covered` null when a single day overflows the fetch cap. In that case `terminalTruncation` and `note` explain that the tool cannot continue within that day. That cannot happen for this fixture.
- Each step's `requested` is the previous step's `continueWith`, and each step's `covered` falls inside its own `requested`.
- Each step's `covered.to` is the day before the previous step's `covered.from`. Read down the printed windows: they should tile `2005-01-01` to `2005-01-31` with no gap and no repeated day.
- `events: 89` at the end. That is the whole saxmatt January 2005 window. The total must not depend on `limit`: the second run should print the same total with more steps and narrower windows. A different total means either the walk lost a day or the fixture moved, so compare it against Trac's own timeline for that range and author before treating it as a regression.
- The 40 step ceiling is a runaway guard. The window is 31 days and every step covers at least one day, so a healthy walk cannot reach it.

## 5. Search pagination

```bash
call /mcp searchTickets '{"query":"milestone=6.9&status=closed","limit":5,"page":1}'
call /mcp searchTickets '{"query":"milestone=6.9&status=closed","limit":5,"page":9999}'
```

Page 1 returns tickets. A page past the end returns `"results": []` while still reporting `totalFound`, `page`, and `pageSize`. An empty page is the correct answer here, not an error.

## 6. ChatGPT compatibility endpoint

```bash
rpc /mcp/chatgpt '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
rpc /mcp/chatgpt '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
call /mcp/chatgpt search '{"query":"editor"}'
call /mcp/chatgpt fetch '{"id":"65739"}'
call /mcp/chatgpt fetch '{"id":"r58504"}'
```

This endpoint advertises exactly `search` and `fetch`. `fetch` takes a bare number for a ticket and an `r` prefix for a changeset.

## 7. Error handling

```bash
rpc  /mcp '{"jsonrpc":"2.0","id":1,"method":"nope/nope"}'
call /mcp doesNotExist '{}'
call /mcp getTicket '{"id":"not-a-number"}'
call /mcp getChangeset '{"revision":-1}'
call /mcp getTimeline '{"days":7,"from":"2005-01-01"}'
call /mcp getTimeline '{"to":"2099-01-01"}'
call /mcp getTimeline '{"from":"2004-12-31","to":"2005-01-01"}'
call /mcp getTracInfo '{}'
```

None of these reaches Trac. The unknown method is a JSON-RPC `-32601` error and the unknown tool a `-32602` error. Every bad argument comes back as a tool result with `isError: true` that names the failing field: a schema violation as plain text beginning `Input validation error:`, and a check the schema cannot express, such as a future date, as JSON with `"code": "invalid_argument"`. A malformed request that returns a success envelope with empty content is a bug.

All three `getTimeline` calls must fail in validation, before any upstream request: `days` cannot be combined with `from` or `to`, `to` cannot be a future date, and dates before `2005-01-01` are outside the verified WordPress Core Trac timeline. A future or too-early date that returns an empty success envelope instead of an error is a bug.

Failures inside a tool return a tool result with `isError: true` and a machine-readable `code` next to the prose `error` message:

```bash
call /mcp getTicket '{"id":99999999}'
call /mcp getChangeset '{"revision":99999999,"includeDiff":false}'
call /mcp searchTickets '{"query":"bogusfield~=value"}'
```

The missing ticket and changeset each return `"code": "not_found"` with `resource` and `id` naming what was requested, for example `{"code": "not_found", "error": "Ticket 99999999 not found", "resource": "ticket", "id": 99999999}`. The unsupported filter field returns `"code": "invalid_argument"`. The full code set and its stability guarantee are documented in the README under "Tool errors".

## 8. Other Trac instances

Each instance is a separate endpoint. These fixtures live on Meta rather than Core:

| Fixture | Covers |
| --- | --- |
| `meta` `5483` | Ticket with comments on a non-Core instance |
| `meta` `r14000` | Changeset on a non-Core instance |
| `meta` `severities` | A field the instance does not configure |
| `themes` `components` | A second, differently shaped missing field |
| `xyzzy-nope` | A slug that resolves but has no Trac behind it |

Confirm one non-Core instance end to end:

```bash
rpc  /mcp/meta '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
call /mcp/meta searchTickets '{"query":"plugin","limit":2}'
call /mcp/meta getTicket '{"id":5483,"includeComments":true,"commentLimit":2}'
call /mcp/meta getChangeset '{"revision":14000,"includeDiff":false}'
call /mcp/meta getTimeline '{"days":7,"limit":3}'
call /mcp/meta getTracInfo '{"type":"components"}'
call /mcp/meta/chatgpt search '{"query":"5483"}'
call /mcp/meta/chatgpt fetch '{"id":"r14000"}'
```

`initialize` names the instance: `Making WordPress.org Trac` rather than `WordPress Trac`. Every `url` in a result points at `meta.trac.wordpress.org`. A result carrying a `core.trac.wordpress.org` URL means the instance was not threaded through, which is the failure this section exists to catch.

Then confirm the rest still answer:

```bash
for slug in themes plugins bbpress buddypress glotpress gsoc; do
  echo "== $slug"; call "/mcp/$slug" searchTickets '{"limit":1}'
done
```

Each returns tickets whose `url` matches its own instance. Instances differ in size and in which fields they configure, so judge these on the request succeeding and the host being right rather than on the counts.

### Fields an instance does not have

```bash
call /mcp/meta   getTracInfo '{"type":"severities"}'
call /mcp/themes getTracInfo '{"type":"components"}'
call /mcp        getTracInfo '{"type":"severities"}'
```

Meta has no severities and Themes has no components. Both return `Severities are not available in ...` / `Components are not available in ...` with `metadata.total` of `0`, and neither is a tool error. Core still returns all six severities in Trac's order (`blocker`, `critical`, `major`, `normal`, `minor`, `trivial`), which is the control: an empty answer there means the query page markup changed and the parser broke.

Filtering on such a field is a tool error rather than an unavailable answer:

```bash
call /mcp/themes searchTickets '{"component":"Widgets","limit":2}'
call /mcp/meta   searchTickets '{"query":"focuses~=accessibility","limit":2}'
call /mcp/meta   searchTickets '{"component":"Plugin Directory","limit":2}'
call /mcp        searchTickets '{"component":"Widgets","limit":2}'
```

The first two fail with `has no component field` / `has no focuses field` and list the fields that instance does have. The last two succeed, because Meta configures components and Core configures both. The difference matters: Trac answers a filter on a field it does not configure with the whole ticket set and a matching `totalFound`, so a passing-looking result here is the bug, not the error.

### Unknown instances

```bash
call /mcp/xyzzy-nope getTicket '{"id":65739}'
call /mcp/xyzzy-nope searchTickets '{"query":"editor","limit":1}'
```

Both return a tool error reading `Unknown or unavailable Trac instance: xyzzy-nope`.

This is the most important check in this section. `*.trac.wordpress.org` has wildcard DNS and redirects every unknown subdomain to Core, so a server that follows redirects answers these with Core's ticket 65739 and a populated search, looking entirely healthy. Core data here is a security regression, not a cosmetic one.

### Rejected paths

```bash
for p in /mcp/ /mcp/Meta /mcp/meta/ /mcp/meta/tools /mcp/chatgpt/chatgpt; do
  printf '%-22s %s\n' "$p" "$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$BASE$p" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}')"
done
```

All five return `404`. Slugs are lowercase, so `/mcp/Meta` is rejected rather than folded to `/mcp/meta`. `chatgpt` is a route keyword rather than an instance, so `/mcp/chatgpt` stays Core's compatibility endpoint and `/mcp/chatgpt/chatgpt` resolves to nothing.

## Reading a failure

Work through these in order before changing a parser.

1. **Does the same check pass locally?** Run the list against `pnpm dev` on current `trunk`. If local passes and the deployment fails, the deployment is behind.

   To confirm that, compare behavior rather than version strings. Run `tools/list` against both and diff the advertised arguments: a deployment missing a field that `trunk` advertises is stale. The version on the landing page is Cloudflare's opaque Worker version ID, not a git commit, so it cannot be matched against a branch. Its deployment timestamp is the useful part, and the Cloudflare dashboard's deployment history maps that ID to what shipped.
2. **Did Trac change, or did we?** Fetch the upstream URL by hand and look at the markup. Trac changing its HTML and our parser regressing produce the same symptom.
3. **Is it the fixture?** These are real public tickets and their content can move. A ticket that gains its first attachment can turn a passing check into a failing one. Confirm the ticket still covers the case in the table above before treating it as a regression.

Do not paste private ticket data or credentials into this file or into fixtures.
