# Timeline coverage instead of pages

Why `getTimeline` reports the range of days it covered rather than a page number.

## Context

Trac's timeline is a newest-first feed with two seek controls: `from`, a calendar day, and `daysback`, a number of days before it. core.trac.wordpress.org clamps `daysback` at Trac's default `max_daysback` of 90. A `max` parameter truncates the response at an event count. There is no offset, no cursor, and no way to ask for the events older than a given event.

`getTimeline` first exposed that feed as `page` and `limit`, answering with `hasMore`, `nextPage`, and `totalEvents`. Review found three failures that follow from the shape rather than from the implementation.

- Every page refetched all the pages before it. Page N asked Trac for `N * limit + 1` events and discarded the first `(N - 1) * limit`. Walking a range cost a shared community server quadratic work.
- Offsets moved between requests. The feed is live and newest first, so a commit landing between two calls shifted every later offset by one, duplicating an event across the page boundary or dropping one. The documented promise of no gaps or duplicates could not be kept.
- `nextPage` could point past the server's own `page * limit <= 1000` validation cap. A client following the documented protocol dead-ended on an invalid-params error at the end of a long range.

## Decision

The unit of coverage is the UTC calendar day, which is the only unit the upstream can seek by.

- A request names a window, as `days` or as `from`/`to`. The response echoes it as `requested`.
- `covered` is the sub-window the response covers completely. It is always whole days.
- `complete` is true when `covered` equals `requested` and every day in it was seen whole. When it is false, `continueWith` holds the `from`/`to` of the uncovered remainder together with the effective `limit` and accepted `author` input, so it can be submitted unchanged.
- The server makes one upstream fetch per request, capped at 500 events, filters the events into `requested` by UTC date, and, if that fetch came back truncated, drops the oldest day because it may be partial. Every day it reports is a day it saw whole.
- `limit` is advisory. Results round down to a day boundary and the newest day is returned in full, so a response can hold more events than `limit` asked for.
- `note` states the coverage in plain language.

A continuation window always ends on a day that is already past, so it is immutable: running it later returns the same events. Walking `continueWith` to `complete` therefore cannot gap or duplicate, by construction rather than by asking clients to keep a snapshot. Coverage that includes today is a claim about the moment of the request; today can gain events afterwards, and re-requesting that day picks them up.

One case this does not serve is a single day holding more events than the fetch cap. The response then cannot claim to have seen that day whole: it reports `complete` as false and says so in `note`, and if the requested window was that one day there is no remainder to continue with. Splitting inside a day would reintroduce the intra-day position the model exists to avoid, so the case is reported rather than engineered around. core.trac runs at tens of events per day.

## Alternatives considered

### Offset pagination

Rejected. The three failures above are inherent to mapping offsets onto an API that seeks by day into a live feed. Capping the offset bounds the refetch cost but leaves the drift and dead-ends deep pages; lifting the cap makes `nextPage` honest only by accepting unbounded refetching of a shared server.

### Opaque cursor

Rejected. Truncation happens at an event, but seeking happens at a day. A cursor would have to encode a position inside a day, and resuming it would mean refetching that whole boundary day and skipping forward to the position, reconstructing on every call the information the day window states outright. A cursor pays for itself when the upstream can seek to an arbitrary position. Trac cannot.

## Consequences

- Walking a window produces no gaps and no duplicates, by construction.
- One upstream request per client request, sized by the fetch cap rather than by how far into the range the caller has already walked. Total upstream work over a walked range is linear in the range instead of quadratic in the number of pages.
- Continuation speaks the tool's own input vocabulary and preserves the filters that define the query. A client can submit it unchanged, with no server state and no cursor to expire, and a person can read the next request.
- Sub-day resumption is given up. A client that wants fewer events than one day holds still receives that whole day. At core.trac's density the overshoot is small.
- Callers that only want the newest activity do not have to know any of this: a bare call still answers for the last seven days in one request.
