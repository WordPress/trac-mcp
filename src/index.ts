import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

const SearchTicketsArgsSchema = z.object({
  query: z
    .string()
    .max(500)
    .default('')
    .describe(
      'Plain keywords (summary-only substring match), a ticket number such as 12345 or #12345, or filter expressions joined by &. Fields: summary, description, owner, reporter, type, status, priority, milestone, component, version, severity, resolution, keywords, cc, focuses. Operators: = exact, ~= contains, != not equal, !~= does not contain. Repeat a field to OR its values, using the same operator each time: status=new&status=assigned. Sort with order=<column> (any field above, plus time and changetime) and desc=1. Example: owner=audrasjb&keywords~=has-patch&status!=closed&order=changetime&desc=1. An expression on a field this instance does not configure is rejected rather than silently ignored.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum number of results to return (default: 10, max: 50)'),
  page: z.number().int().min(1).default(1).describe('One-based results page (default: 1)'),
  status: z
    .enum(['accepted', 'assigned', 'closed', 'new', 'reopened', 'reviewing'])
    .optional()
    .describe(
      'Exact-match convenience for one status. It overrides status in query; use status=... in query for OR or negation.'
    ),
  component: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Exact-match convenience for one component name (e.g., 'Administration', 'Posts, Post Types'). It overrides component in query; use component~=... in query for a substring match. Call getTracInfo with type components for the names this instance uses."
    ),
  milestone: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Exact-match convenience for one milestone (e.g., '6.9'). It overrides milestone in query. Call getTracInfo with type milestones for the names this instance uses."
    ),
  resolution: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Exact-match convenience for one resolution (e.g., 'fixed', 'wontfix', 'duplicate'). It overrides resolution in query."
    ),
});
// The whole ticket RSS is fetched before slicing, so the cap only bounds response size.
const TICKET_COMMENT_LIMIT_MAX = 500;
const GetTicketArgsSchema = z.object({
  id: z.number().int().positive().describe('Trac ticket ID number'),
  includeComments: z
    .boolean()
    .default(true)
    .describe('Include ticket comments and discussion (default: true)'),
  commentLimit: z
    .number()
    .int()
    .min(0)
    .max(TICKET_COMMENT_LIMIT_MAX)
    .default(10)
    .describe(
      'Maximum number of comments to return, newest first from the end of the discussion (default: 10, max: 500). Compare returnedComments with totalComments to see whether older comments were left out.'
    ),
});
const GetChangesetArgsSchema = z.object({
  revision: z.number().int().positive().describe('SVN revision number (e.g., 58504)'),
  includeDiff: z.boolean().default(true).describe('Include diff content (default: true)'),
  diffLimit: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(2000)
    .describe('Maximum characters of diff to return (default: 2000, max: 10000)'),
});
// core.trac.wordpress.org clamps the timeline's daysback parameter at Trac's
// default max_daysback of 90; wider requests silently lose the oldest events.
const TIMELINE_MAX_WINDOW_DAYS = 90;
const TIMELINE_DEFAULT_WINDOW_DAYS = 7;
// The timeline feed honors max up to 1001. One generous fetch covers far more
// than a busy core.trac day, and the day-based coverage report below stays
// honest when it is not enough.
const TIMELINE_FETCH_MAX = 500;
const DAY_IN_MS = 86_400_000;
const TIMELINE_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
// The repository's live historical fixture starts in January 2005, the oldest
// Core history verified; younger instances simply have no events before their own first day.
const TIMELINE_EARLIEST_DATE = '2005-01-01';
// A leading alphanumeric keeps user input from reaching Trac's `-author`
// exclusion syntax, and the quote-free charset makes quoting spaced names safe.
// Leading, trailing, and doubled spaces are rejected because Trac quotes them
// verbatim into the authors filter, where they match nobody.
const TIMELINE_AUTHOR_PATTERN = '^[A-Za-z0-9](?: ?[A-Za-z0-9@._-])*$';

function timelineDayTimestamp(value: string): number {
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  // Date.UTC maps years 0-99 onto 1900-1999 while setUTCFullYear does not, so
  // dates such as 0099-12-31 survive the roundtrip check below.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // Impossible dates such as 2005-02-31 roll over into the next month, so only
  // a component roundtrip proves the date was real.
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.getTime()
    : Number.NaN;
}

function timelineDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function shiftTimelineDay(day: string, offset: number): string {
  return timelineDay(timelineDayTimestamp(day) + offset * DAY_IN_MS);
}

function timelineDaySpan(from: string, to: string): number {
  return Math.round((timelineDayTimestamp(to) - timelineDayTimestamp(from)) / DAY_IN_MS);
}

const TimelineDateSchema = z
  .string()
  .regex(new RegExp(TIMELINE_DATE_PATTERN), 'Dates must be ISO-8601 (YYYY-MM-DD)');
const TimelineAuthorSchema = z
  .string()
  .regex(
    new RegExp(TIMELINE_AUTHOR_PATTERN),
    'Authors must be Trac usernames: letters or numbers, then letters, numbers, single interior spaces, or @._-'
  )
  .max(50);
export const GetTimelineArgsSchema = z
  .object({
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe(
        'Number of inclusive calendar days ending today (UTC), defaults to 7 when neither from nor to is given. Cannot be combined with from or to. Calls that use only days and limit pass it to Trac as daysback unchanged, the original behavior, which also includes the day before the window.'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe(
        'Maximum number of events for calls that use only days and limit. For date-range or author-filtered calls, this is advisory: results are trimmed to whole days from the oldest end, and the newest complete day is returned in full even when it holds more events than limit.'
      ),
    from: TimelineDateSchema.optional().describe(
      'Inclusive ISO-8601 start date (YYYY-MM-DD), not earlier than 2005-01-01. The from-to window may span at most 90 days per request; query adjacent ranges for longer periods.'
    ),
    to: TimelineDateSchema.optional().describe(
      'Inclusive ISO-8601 end date (YYYY-MM-DD); the resolved window must not begin before 2005-01-01, and dates later than today (UTC) are rejected. Defaults to today when only from is given; to alone covers the 7 inclusive days ending at to.'
    ),
    author: z
      .union([TimelineAuthorSchema, z.array(TimelineAuthorSchema).min(1).max(10)])
      .optional()
      .describe(
        'Trac username, or list of up to 10 usernames, to filter events by author. Filtering happens on the server, so results stay complete even when the unfiltered window holds more events than limit.'
      ),
  })
  // Only clock-independent rules belong here; the window itself is resolved and
  // validated against a single reading of the clock in resolveTimelineQuery.
  .superRefine((args, ctx) => {
    if (args.days !== undefined && (args.from !== undefined || args.to !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'days cannot be combined with from or to; use from and to for historical ranges',
      });
      return;
    }
    for (const [label, value] of [
      ['from', args.from],
      ['to', args.to],
    ] as const) {
      if (value !== undefined && Number.isNaN(timelineDayTimestamp(value))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} is not a valid calendar date: ${value}`,
        });
        return;
      }
    }
  });
const GetTracInfoArgsSchema = z.object({
  type: z
    .enum(['components', 'milestones', 'priorities', 'severities', 'types', 'statuses'])
    .describe('Type of Trac information to retrieve'),
});
const ChatGptSearchArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      'Search query for WordPress Trac. Can be keywords, ticket numbers, revision numbers, or component names.'
    ),
});
const ChatGptFetchArgsSchema = z.object({
  id: z
    .string()
    .regex(/^(?:r\d+|\d+)$/, 'Use a ticket number or an r-prefixed changeset')
    .describe(
      "The ID of the item to fetch detailed information for (e.g., '61234' for ticket, 'r58504' for changeset)."
    ),
});

function normalizeEmptyRecord(value: unknown) {
  return Array.isArray(value) && value.length === 0 ? {} : value;
}

const LinkedPullRequestSchema = z.object({
  number: z.number().int().positive(),
  repo: z.string(),
  state: z.string(),
  title: z.string(),
  user: z.object({
    name: z.string(),
    url: z.string().url(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  changes: z.object({
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    patch_url: z.string().url(),
    html_url: z.string().url(),
  }),
  touches_tests: z.boolean(),
  check_runs: z.preprocess(normalizeEmptyRecord, z.record(z.string(), z.string())),
  reviews: z.preprocess(normalizeEmptyRecord, z.record(z.string(), z.array(z.string()))),
  mergeable_state: z.string(),
  body: z.string().nullable(),
  html_url: z.string().url(),
});

// Argument checks that Zod cannot express, reported as invalid_argument tool errors.
class InvalidToolArgumentsError extends Error {}

// Stable, machine-readable tool error codes. These are API surface documented in the README:
// consumers branch on them, so codes only change with a version bump. Messages can change freely.
type ToolErrorCode = 'not_found' | 'invalid_argument' | 'rate_limited' | 'upstream_error';

class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details: { resource?: 'ticket' | 'changeset'; id?: number };

  constructor(code: ToolErrorCode, message: string, details: ToolError['details'] = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

function upstreamHttpError(
  response: Response,
  message = `HTTP ${response.status}: ${response.statusText}`
): ToolError {
  return new ToolError(response.status === 429 ? 'rate_limited' : 'upstream_error', message);
}

/*
 * Distinct from an ordinary upstream failure so callers that turn "not found"
 * into an empty result do not also swallow a Trac that does not exist.
 */
class UnknownTracInstanceError extends Error {}

const TRAC_USER_AGENT = 'Mozilla/5.0 (compatible; WordPress-Trac-MCP-Server/1.0)';
const TRAC_RETRY_DELAYS_MS = [2000, 4000, 8000] as const;

const TRAC_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/*
 * `chatgpt` is a route keyword rather than an instance, so /mcp/chatgpt keeps
 * meaning "core, ChatGPT tools" instead of resolving a Trac named chatgpt.
 */
const RESERVED_TRAC_SLUGS = new Set(['chatgpt']);

/*
 * Known instances, in landing page order. Any other well-formed slug still
 * resolves and falls back to its slug as a label; this is a discovery aid
 * rather than an allowlist.
 */
const TRAC_LABELS: Record<string, string> = {
  core: 'WordPress',
  meta: 'Making WordPress.org',
  themes: 'WordPress Themes',
  plugins: 'WordPress Plugins',
  bbpress: 'bbPress',
  buddypress: 'BuddyPress',
  glotpress: 'GlotPress',
  gsoc: 'Google Summer of Code',
};

export type TracInstance = {
  slug: string;
  origin: string;
  label: string;
};

/**
 * Build an instance from a slug that has already been validated.
 *
 * @param slug Subdomain label of a *.trac.wordpress.org instance.
 * @return The instance.
 */
function makeTracInstance(slug: string): TracInstance {
  return {
    slug,
    origin: `https://${slug}.trac.wordpress.org`,
    label: TRAC_LABELS[slug] ?? slug,
  };
}

/**
 * Resolve a URL path segment to a Trac instance.
 *
 * @param slug Subdomain label of a *.trac.wordpress.org instance.
 * @return The instance, or null when the slug is malformed or reserved.
 */
export function tracInstance(slug: string): TracInstance | null {
  return TRAC_SLUG_PATTERN.test(slug) && !RESERVED_TRAC_SLUGS.has(slug)
    ? makeTracInstance(slug)
    : null;
}

export const CORE_TRAC = makeTracInstance('core');

/**
 * Human-readable name for an instance, used in server info and tool output.
 */
function tracDisplayName(instance: TracInstance): string {
  return `${instance.label} Trac`;
}
const TICKET_COLUMNS = [
  'id',
  'summary',
  'owner',
  'reporter',
  'type',
  'status',
  'priority',
  'milestone',
  'component',
  'version',
  'severity',
  'resolution',
  'keywords',
  'cc',
  'focuses',
] as const;

type TracField = (typeof TICKET_COLUMNS)[number] | 'description';
type TracRecord = Partial<Record<TracField, string>> & Record<string, string | undefined>;
type TicketSearchFilters = {
  status?: string | undefined;
  component?: string | undefined;
  milestone?: string | undefined;
  resolution?: string | undefined;
};

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isTransientTracResponse(response: Response): Promise<boolean> {
  if (response.status === 429 || response.status >= 500) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }

  return /Checking your browser/i.test(await response.clone().text());
}

/**
 * Whether a response is a redirect that must not be followed.
 *
 * The status range is what `redirect: 'manual'` produces. `redirected` cannot be
 * true alongside it and is kept as a backstop: a runtime that ignored the option
 * would hand back another instance's page, which is the one thing never to return.
 *
 * @param response Response to a request that asked not to follow redirects.
 * @return True when the response redirects.
 */
function isRedirect(response: Response): boolean {
  return response.redirected || (response.status >= 300 && response.status < 400);
}

/**
 * Origin a redirect response points at.
 *
 * @param response A redirect response.
 * @param requestUrl URL the response answers, used to resolve a relative target.
 * @return The target origin, or null when there is no usable Location header.
 */
function redirectOrigin(response: Response, requestUrl: URL): string | null {
  const location = response.headers.get('location');
  if (!location) {
    return null;
  }

  try {
    return new URL(location, requestUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Failure to report for a redirect, which is never followed.
 *
 * @param instance Instance the request addressed.
 * @param response The redirect response.
 * @param requestUrl URL the response answers.
 * @return The error to throw.
 */
function redirectError(instance: TracInstance, response: Response, requestUrl: URL): Error {
  // A slug with no Trac behind it redirects off-origin; one that stays put is something else.
  const target = redirectOrigin(response, requestUrl);
  return target && target !== instance.origin
    ? new UnknownTracInstanceError(`Unknown or unavailable Trac instance: ${instance.slug}`)
    : new Error(`Unexpected redirect from ${instance.origin}: HTTP ${response.status}`);
}

export async function fetchTrac(
  instance: TracInstance,
  input: string | URL,
  init?: RequestInit,
  retryDelays: readonly number[] = TRAC_RETRY_DELAYS_MS
): Promise<Response> {
  const url = new URL(input);
  if (url.origin !== instance.origin) {
    throw new Error(`Refusing non-Trac request host: ${url.hostname}`);
  }

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      // Never follow a redirect: unknown subdomains point at core, whose data is not ours to return.
      response = await fetch(url.toString(), { ...init, redirect: 'manual' });
    } catch (error) {
      if (attempt >= retryDelays.length) {
        throw error;
      }
      await wait(retryDelays[attempt] ?? 0);
      continue;
    }

    if (isRedirect(response)) {
      throw redirectError(instance, response, url);
    }
    if (!(await isTransientTracResponse(response)) || attempt >= retryDelays.length) {
      return response;
    }

    await wait(retryDelays[attempt] ?? 0);
  }
}

type TicketHistoryEntry = {
  id: number | null;
  author: string;
  timestamp: string;
  changes: string;
  comment: string;
  url: string;
};

// A numbered history entry left out of comments, so a gap in the IDs is explained.
type OmittedTicketComment = {
  id: number;
  author: string;
  reason: 'bot' | 'cc' | 'empty';
};

type LinkedPullRequest = {
  number: number;
  repository: string;
  state: string;
  title: string;
  author: string;
  authorUrl: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  additions: number;
  deletions: number;
  touchesTests: boolean;
  checkRuns: Record<string, string>;
  reviews: Record<string, string[]>;
  mergeableState: string;
  patchUrl: string;
  url: string;
  body: string;
};

type TicketAttachment = {
  filename: string;
  author: string;
  timestamp: string;
  description: string;
  url: string;
};

type TicketChangeset = {
  revision: number;
  author: string;
  timestamp: string;
  changes: string;
  message: string;
  url: string;
};

/*
 * Trac escapes its content once per format it passes through. An RSS item body is HTML
 * escaped as XML, so `<code>&lt;script&gt;</code>` arrives as
 * `&lt;code&gt;&amp;lt;script&amp;gt;&lt;/code&gt;`. Each level is undone by exactly one
 * pass of the matching decoder, in order: XML when the item is read, HTML after the tags
 * are stripped. Decoding twice, or decoding before stripping, turns escaped markup into a
 * tag and the tag stripper then deletes it.
 */
const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

const HTML_ENTITIES: Record<string, string> = { ...XML_ENTITIES, nbsp: ' ' };

const ENTITY_REFERENCE = /&(#x[\da-f]+|#\d+|[a-z]+);/gi;

function decodeEntities(value: string, named: Record<string, string>): string {
  return value.replace(ENTITY_REFERENCE, (entity: string, code: string) => {
    if (code[0] !== '#') {
      return named[code.toLowerCase()] ?? entity;
    }

    const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10;
    const digits = radix === 16 ? code.slice(2) : code.slice(1);
    const point = Number.parseInt(digits, radix);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : entity;
  });
}

function decodeXmlEntities(value: string): string {
  return decodeEntities(value, XML_ENTITIES);
}

function decodeHtmlEntities(value: string): string {
  return decodeEntities(value, HTML_ENTITIES);
}

function normalizeTracText(value: string): string {
  return value
    .replace(/[\u200B\uFEFF]/g, '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/*
 * Trac decorates every link it renders: `class` for styling, `title` with a summary of the
 * target, and an empty `<span class="icon">` before external link text. None of that helps a
 * reader, so only the href is kept. Hrefs stay entity-encoded here because the whole text is
 * decoded once at the end.
 */
function rewriteAnchor(tag: string, origin: string): string {
  const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  const target = href?.[1] ?? href?.[2] ?? href?.[3];
  if (!target) {
    return '';
  }

  try {
    const url = new URL(target, origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `<a href="${url.href}">` : '';
  } catch {
    return '';
  }
}

/*
 * Takes an HTML fragment and returns text, keeping links as `<a href>` with an absolute URL.
 * Agents read HTML, and a Trac comment that points at a pull request or another ticket loses
 * its point when the URL goes. Callers reading RSS must decode the XML level first, which
 * `readXmlText` does.
 */
export function cleanTracText(html: string, origin: string): string {
  const anchors: boolean[] = [];
  const text = html
    .replace(/<span\s[^>]*class=["']?icon["']?[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<[^>]*>/g, (tag) => {
      if (/^<br\s*\/?>$/i.test(tag)) {
        return '\n';
      }
      if (/^<\/(?:div|li|ol|p|pre|tr|ul)>$/i.test(tag)) {
        return '\n';
      }
      if (/^<li[\s>]/i.test(tag)) {
        return '- ';
      }
      if (/^<a[\s>]/i.test(tag)) {
        const anchor = rewriteAnchor(tag, origin);
        anchors.push(anchor !== '');
        return anchor;
      }
      // An unbalanced `</a>` closes nothing; drop it with the rest of the markup.
      if (/^<\/a\s*>$/i.test(tag)) {
        return anchors.pop() ? '</a>' : '';
      }
      return '';
    });

  return normalizeTracText(decodeHtmlEntities(text));
}

function extractXmlElement(source: string, tag: string): string {
  const match = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1] ?? '';
}

// One XML decode, or none at all when the element carries its content as CDATA.
function readXmlText(source: string, tag: string): string {
  const raw = extractXmlElement(source, tag);
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return cdata?.[1] ?? decodeXmlEntities(raw);
}

function parseRssItems(rssText: string, origin: string) {
  return Array.from(rssText.matchAll(/<item>([\s\S]*?)<\/item>/gi), (match) => {
    const item = match[1] ?? '';
    const descriptionHtml = readXmlText(item, 'description');
    return {
      // Trac writes these four as plain text, so the XML decode leaves nothing to strip.
      title: normalizeTracText(readXmlText(item, 'title')),
      link: normalizeTracText(readXmlText(item, 'link')),
      date: normalizeTracText(readXmlText(item, 'pubDate')),
      author: normalizeTracText(readXmlText(item, 'dc:creator')),
      description: cleanTracText(descriptionHtml, origin),
      descriptionHtml,
    };
  });
}

const TICKET_FIELDS = new Set([
  'attachment',
  'cc',
  'component',
  'description',
  'focuses',
  'keywords',
  'milestone',
  'owner',
  'priority',
  'reporter',
  'resolution',
  'severity',
  'status',
  'summary',
  'type',
  'version',
]);

type TicketFieldChange = { field: string; value: string };

// Trac's RSS title names the fields an entry changed; a comment with no changes has an empty
// title, so a bulleted list there is prose and not a change list.
function splitTicketHistoryDescription(html: string, origin: string, title: string) {
  const list = title.trim() ? html.match(/^\s*<ul(?:\s[^>]*)?>([\s\S]*?)<\/ul>\s*/i) : null;
  if (!list?.[0] || !list[1]) {
    return { html, body: cleanTracText(html, origin) };
  }

  const items = Array.from(list[1].matchAll(/<li(?:\s[^>]*)?>([\s\S]*?)<\/li>/gi), (match) => {
    const label = (match[1] ?? '').match(/<strong(?:\s[^>]*)?>([^<]+)<\/strong>([\s\S]*)$/i);
    return {
      field: label?.[1]?.trim().toLowerCase() ?? '',
      // A field set for the first time renders as "→ new"; the arrow says nothing on its own.
      value: cleanTracText(label?.[2] ?? '', origin).replace(/^→\s*/, ''),
    };
  });
  const unmatched = list[1].replace(/<li(?:\s[^>]*)?>[\s\S]*?<\/li>/gi, '').trim();
  if (
    unmatched ||
    items.length === 0 ||
    items.some(({ field }) => !field || !TICKET_FIELDS.has(field))
  ) {
    return { html, body: cleanTracText(html, origin) };
  }

  const narrativeHtml = html.slice(list[0].length);
  return { html, body: cleanTracText(narrativeHtml, origin), narrativeHtml, fields: items };
}

// cc churn is noise on every long ticket; everything else Trac records is kept.
const OMITTED_CHANGE_FIELDS = new Set(['cc']);

function describeTicketChanges(fields: TicketFieldChange[] | undefined, title: string): string {
  if (fields === undefined) {
    return filterTicketFieldChurn(title);
  }
  return fields
    .filter(({ field }) => !OMITTED_CHANGE_FIELDS.has(field))
    .map(({ field, value }) => (value ? `${field}: ${value}` : field))
    .join('; ');
}

function filterTicketFieldChurn(changes: string): string {
  return changes
    .split(';')
    .map((clause) => {
      const match = clause.trim().match(/^(.+?)\s+(set|changed|deleted)$/i);
      if (!match?.[1] || !match[2]) {
        return clause.trim();
      }
      const fields = match[1]
        .split(',')
        .map((field) => field.trim())
        .filter((field) => !OMITTED_CHANGE_FIELDS.has(field.toLowerCase()));
      return fields.length ? `${fields.join(', ')} ${match[2]}` : '';
    })
    .filter(Boolean)
    .join('; ');
}

function attachmentFilename(html: string, origin: string): string {
  const emphasized = html.match(/<em(?:\s[^>]*)?>([\s\S]*?)<\/em>/i)?.[1];
  const fieldValue = html.match(
    /<strong(?:\s[^>]*)?>\s*attachment\s*<\/strong>[\s\S]*?<span\s+class=["']trac-field-new["'][^>]*>([\s\S]*?)<\/span>/i
  )?.[1];
  return cleanTracText(emphasized ?? fieldValue ?? '', origin);
}

type RssItem = ReturnType<typeof parseRssItems>[number];
type ClassifiedTicketHistory =
  | { kind: 'attachment'; entry: TicketAttachment }
  | { kind: 'changeset'; entry: TicketChangeset }
  | { kind: 'comment'; entry: TicketHistoryEntry }
  | { kind: 'omitted'; entry: OmittedTicketComment };

function ticketCommentId(link: string): number | null {
  const id = link.match(/#comment:(\d+)/)?.[1];
  return id ? Number.parseInt(id, 10) : null;
}

function omittedTicketComment(
  item: RssItem,
  reason: OmittedTicketComment['reason']
): ClassifiedTicketHistory | null {
  const id = ticketCommentId(item.link);
  return id === null ? null : { kind: 'omitted', entry: { id, author: item.author, reason } };
}

function classifyTicketHistoryItem(
  instance: TracInstance,
  ticketId: number,
  item: RssItem
): ClassifiedTicketHistory | null {
  if (['prbot', 'slackbot'].includes(item.author.toLowerCase())) {
    return omittedTicketComment(item, 'bot');
  }
  if (/#description$/.test(item.link)) {
    return null;
  }

  const parsedDescription = splitTicketHistoryDescription(
    item.descriptionHtml,
    instance.origin,
    item.title
  );
  if (item.title.toLowerCase() === 'attachment set') {
    const filename = attachmentFilename(parsedDescription.html, instance.origin);
    return {
      kind: 'attachment',
      entry: {
        filename,
        author: item.author,
        timestamp: item.date,
        description: parsedDescription.body,
        url: filename
          ? `${instance.origin}/raw-attachment/ticket/${ticketId}/${encodeURIComponent(filename)}`
          : '',
      },
    };
  }

  const narrativeHtml = parsedDescription.narrativeHtml ?? parsedDescription.html;
  const changesetMatch = narrativeHtml.match(
    /^\s*<p>\s*In\s*<a\b(?=[^>]*\bclass=["'][^"']*\bchangeset\b[^"']*["'])[^>]*>\[?(\d+)\]?<\/a>\s*:?\s*<\/p>\s*/i
  );
  if (changesetMatch?.[1]) {
    const revision = Number.parseInt(changesetMatch[1], 10);
    return {
      kind: 'changeset',
      entry: {
        revision,
        author: item.author,
        timestamp: item.date,
        changes: describeTicketChanges(parsedDescription.fields, item.title),
        message: cleanTracText(narrativeHtml.slice(changesetMatch[0].length), instance.origin),
        url: `${instance.origin}/changeset/${revision}`,
      },
    };
  }

  const changes = describeTicketChanges(parsedDescription.fields, item.title);
  if (!changes && !parsedDescription.body) {
    return omittedTicketComment(
      item,
      parsedDescription.fields || /\bcc\b/i.test(item.title) ? 'cc' : 'empty'
    );
  }
  return {
    kind: 'comment',
    entry: {
      id: ticketCommentId(item.link),
      author: item.author,
      timestamp: item.date,
      changes,
      comment: parsedDescription.body,
      url: item.link,
    },
  };
}

function classifyTicketHistory(instance: TracInstance, ticketId: number, rssText: string) {
  const comments: TicketHistoryEntry[] = [];
  const attachments: TicketAttachment[] = [];
  const changesets: TicketChangeset[] = [];
  const omittedComments: OmittedTicketComment[] = [];

  for (const item of parseRssItems(rssText, instance.origin)) {
    const classified = classifyTicketHistoryItem(instance, ticketId, item);
    if (classified?.kind === 'comment') {
      comments.push(classified.entry);
    } else if (classified?.kind === 'attachment') {
      attachments.push(classified.entry);
    } else if (classified?.kind === 'changeset') {
      changesets.push(classified.entry);
    } else if (classified?.kind === 'omitted') {
      omittedComments.push(classified.entry);
    }
  }

  return { comments, attachments, changesets, omittedComments };
}

export function parseCsvRecords(csvData: string): TracRecord[] {
  const lines = csvData.trim().split(/\r?\n/);
  const headers = parseCSVLine(lines.shift() ?? '').map((header) =>
    header
      .replace(/^\uFEFF/, '')
      .trim()
      .toLowerCase()
  );

  return lines.filter(Boolean).map((line) => {
    const values = parseCSVLine(line);
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index]?.trim() ?? ''])
    );
  });
}

/**
 * Ticket fields an instance configures, read from the filter picker on a query page.
 *
 * Instances differ: themes has no component, and only some have severity. Trac
 * drops a filter on a field it does not configure instead of rejecting it, so
 * this list is what separates an unsupported filter from a matching one.
 *
 * @param html A Trac query page.
 * @return The configured field names, or null when the page is not a query page.
 */
function configuredTracFields(html: string): Set<string> | null {
  const picker = html.match(/<select[^>]*\bname="add_filter_0"[^>]*>([\s\S]*?)<\/select>/i)?.[1];
  if (picker === undefined) {
    return null;
  }

  return new Set(
    Array.from(
      picker.matchAll(/<option[^>]*\bvalue="([^"]+)"/gi),
      (match) => match[1] ?? ''
    ).filter(Boolean)
  );
}

// Query parameters that shape the response rather than filter it; the field check skips them.
const QUERY_CONTROL_PARAMS = new Set(['col', 'desc', 'format', 'max', 'order', 'page']);

/**
 * Ticket fields a query URL filters on.
 *
 * @param url A Trac query URL this server built.
 * @return The field names filtered on, without the parameters that shape the response.
 */
function ticketFilterFields(url: URL): string[] {
  return Array.from(new Set(url.searchParams.keys())).filter(
    (name) => !QUERY_CONTROL_PARAMS.has(name)
  );
}

function addColumns(url: URL, columns: readonly string[]): void {
  for (const column of columns) {
    url.searchParams.append('col', column);
  }
}

// Trac's sortable columns: every ticket column plus the two timestamps.
const TICKET_ORDER_COLUMNS = new Set<string>([...TICKET_COLUMNS, 'time', 'changetime']);
// Sort columns that never appear in a query page's filter picker.
const TICKET_ORDER_COLUMNS_UNFILTERED = new Set(['id', 'time', 'changetime']);

export function parseTicketFilter(expression: string): [string, string] {
  const match = expression.match(/^([a-z][a-z0-9_]*)(!?~?=)(.+)$/i);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new ToolError(
      'invalid_argument',
      `Invalid ticket filter expression: ${expression}. Use field=value, field~=value, field!=value, or field!~=value`
    );
  }

  const field = match[1].toLowerCase();
  const operator = match[2];
  const value = match[3];
  if (field === 'order') {
    const column = value.toLowerCase();
    if (operator !== '=' || !TICKET_ORDER_COLUMNS.has(column)) {
      throw new ToolError(
        'invalid_argument',
        `Unsupported sort column: ${value}. Use order=<column> with one of ${Array.from(TICKET_ORDER_COLUMNS).join(', ')}`
      );
    }
    return ['order', column];
  }
  if (field === 'desc') {
    if (operator !== '=' || !/^(?:1|true|0|false)$/i.test(value)) {
      throw new ToolError(
        'invalid_argument',
        `Unsupported desc value: ${value}. Use desc=1 or desc=0`
      );
    }
    return ['desc', /^(?:1|true)$/i.test(value) ? '1' : '0'];
  }
  if (
    !TICKET_COLUMNS.includes(field as (typeof TICKET_COLUMNS)[number]) &&
    field !== 'description'
  ) {
    throw new ToolError('invalid_argument', `Unsupported ticket filter: ${field}`);
  }

  // Trac's value prefix is the operator without its trailing =.
  return [field, `${operator.slice(0, -1)}${value}`];
}

export function addTicketSearchQuery(url: URL, query: string): void {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return;
  }

  const ticketNumber = trimmedQuery.match(/^#?(\d+)$/);
  if (ticketNumber?.[1]) {
    url.searchParams.set('id', ticketNumber[1]);
    return;
  }

  if (!/[~=]/.test(trimmedQuery)) {
    url.searchParams.set('summary', `~${trimmedQuery}`);
    return;
  }

  // Trac reads one operator per field, from its first value, so mixing them is rejected.
  const operators = new Map<string, string>();
  for (const expression of trimmedQuery.split('&')) {
    const [field, value] = parseTicketFilter(expression);
    if (QUERY_CONTROL_PARAMS.has(field)) {
      url.searchParams.set(field, value);
      continue;
    }
    const operator = value.match(/^(!~|!|~)?/)?.[1] ?? '';
    const previous = operators.get(field);
    if (previous !== undefined && previous !== operator) {
      throw new ToolError(
        'invalid_argument',
        `Repeated ${field} filters must use the same operator; Trac applies the first one to every value`
      );
    }
    operators.set(field, operator);
    url.searchParams.append(field, value);
  }
}

async function fetchCsvRecords(instance: TracInstance, url: URL): Promise<TracRecord[]> {
  const response = await fetchTrac(instance, url, {
    headers: {
      'User-Agent': TRAC_USER_AGENT,
      Accept: 'text/csv,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw upstreamHttpError(response);
  }

  const csvData = await response.text();
  if (/<!doctype html|<html/i.test(csvData)) {
    throw new ToolError('upstream_error', 'Trac returned HTML instead of CSV');
  }

  return parseCsvRecords(csvData);
}

function ticketFromRecord(record: TracRecord) {
  return {
    id: Number.parseInt(record.id ?? '', 10),
    summary: record.summary ?? '',
    owner: record.owner ?? '',
    reporter: record.reporter ?? '',
    type: record.type ?? '',
    status: record.status ?? '',
    priority: record.priority ?? '',
    milestone: record.milestone ?? '',
    component: record.component ?? '',
    version: record.version ?? '',
    severity: record.severity ?? '',
    resolution: record.resolution ?? '',
    keywords: record.keywords ?? '',
    cc: record.cc ?? '',
    focuses: record.focuses ?? '',
  };
}

async function fetchLinkedPullRequests(
  instance: TracInstance,
  ticketId: number
): Promise<LinkedPullRequest[]> {
  const pullRequestsUrl = new URL('https://api.wordpress.org/dotorg/trac/pr/');
  pullRequestsUrl.searchParams.set('trac', instance.slug);
  pullRequestsUrl.searchParams.set('ticket', ticketId.toString());

  // One fixed host rather than a wildcard domain, so a redirect means it moved: follow it.
  const response = await fetch(pullRequestsUrl.toString(), {
    headers: {
      'User-Agent': TRAC_USER_AGENT,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch linked pull requests: ${response.statusText}`);
  }

  return z
    .array(LinkedPullRequestSchema)
    .parse(await response.json())
    .map((pullRequest) => ({
      number: pullRequest.number,
      repository: pullRequest.repo,
      state: pullRequest.state,
      title: pullRequest.title,
      author: pullRequest.user.name,
      authorUrl: pullRequest.user.url,
      createdAt: pullRequest.created_at,
      updatedAt: pullRequest.updated_at,
      closedAt: pullRequest.closed_at,
      additions: pullRequest.changes.additions,
      deletions: pullRequest.changes.deletions,
      touchesTests: pullRequest.touches_tests,
      checkRuns: pullRequest.check_runs,
      reviews: pullRequest.reviews,
      mergeableState: pullRequest.mergeable_state,
      patchUrl: pullRequest.changes.patch_url,
      url: pullRequest.html_url,
      body: pullRequest.body ?? '',
    }));
}

export async function searchTracTickets(
  instance: TracInstance,
  query: string,
  limit: number,
  page: number,
  filters: TicketSearchFilters = {}
) {
  const queryUrl = new URL(`${instance.origin}/query`);
  const pageSize = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const pageNumber = Math.max(Math.trunc(page), 1);
  queryUrl.searchParams.set('format', 'csv');
  queryUrl.searchParams.set('max', pageSize.toString());
  queryUrl.searchParams.set('page', pageNumber.toString());
  addColumns(queryUrl, [
    'id',
    'summary',
    'owner',
    'type',
    'status',
    'priority',
    'milestone',
    'component',
  ]);

  addTicketSearchQuery(queryUrl, query);

  for (const [field, value] of Object.entries(filters)) {
    if (value) {
      queryUrl.searchParams.set(field, value);
    }
  }

  const totalUrl = new URL(queryUrl);
  totalUrl.searchParams.delete('format');
  totalUrl.searchParams.delete('page');
  const [records, totalResponse] = await Promise.all([
    fetchCsvRecords(instance, queryUrl),
    fetchTrac(instance, totalUrl, { headers: { 'User-Agent': TRAC_USER_AGENT } }),
  ]);
  const tickets = records.map(ticketFromRecord);
  const filterFields = ticketFilterFields(queryUrl);
  if (!totalResponse.ok) {
    // Without the field list, a filter Trac dropped cannot be told from one it applied.
    if (filterFields.length) {
      throw new Error(
        `Cannot confirm the ${filterFields.join(' and ')} filter against ${tracDisplayName(instance)} because its query page returned HTTP ${totalResponse.status}. Trac ignores a filter on a field it does not configure, so these results could be the whole ticket list.`
      );
    }

    return {
      tickets,
      totalFound: (pageNumber - 1) * pageSize + tickets.length,
      returned: tickets.length,
      page: pageNumber,
      pageSize,
      hasMore: false,
    };
  }

  const totalHtml = await totalResponse.text();

  // The count page is a query page, so it carries the field list this filter has to exist in.
  const configured = configuredTracFields(totalHtml);
  if (configured) {
    const unsupported = filterFields.filter((field) => !configured.has(field));
    if (unsupported.length) {
      throw new ToolError(
        'invalid_argument',
        `${tracDisplayName(instance)} has no ${unsupported.join(' or ')} field, so filtering on it would return every ticket. Fields available here: ${Array.from(configured).sort().join(', ')}`
      );
    }
    const order = queryUrl.searchParams.get('order');
    if (order && !configured.has(order) && !TICKET_ORDER_COLUMNS_UNFILTERED.has(order)) {
      throw new ToolError(
        'invalid_argument',
        `${tracDisplayName(instance)} has no ${order} field to sort by, so Trac would fall back to its default order. Fields available here: ${Array.from(configured).sort().join(', ')}`
      );
    }
  }

  const totalMatch = totalHtml.match(/<span class="numrows">\s*\(([\d,]+)\s+match(?:es)?\)/i);
  if (!totalMatch?.[1]) {
    throw new ToolError('upstream_error', 'Trac did not return the total ticket count');
  }

  const totalFound = Number.parseInt(totalMatch[1].replace(/,/g, ''), 10);
  return {
    tickets,
    totalFound,
    returned: tickets.length,
    page: pageNumber,
    pageSize,
    hasMore: pageNumber * pageSize < totalFound,
  };
}

async function fetchTicket(
  instance: TracInstance,
  ticketId: number,
  includeComments: boolean,
  commentLimit = 10
) {
  const queryUrl = new URL(`${instance.origin}/query`);
  queryUrl.searchParams.set('format', 'csv');
  queryUrl.searchParams.set('max', '1');
  queryUrl.searchParams.set('id', ticketId.toString());
  addColumns(queryUrl, TICKET_COLUMNS);

  const rssUrl = `${instance.origin}/ticket/${ticketId}?format=rss`;
  const [records, rssResponse, linkedPullRequestsResult] = await Promise.all([
    fetchCsvRecords(instance, queryUrl),
    fetchTrac(instance, rssUrl, { headers: { 'User-Agent': TRAC_USER_AGENT } }),
    fetchLinkedPullRequests(instance, ticketId)
      .then((linkedPullRequests) => ({ linkedPullRequests, unavailable: false }))
      .catch(() => ({ linkedPullRequests: [], unavailable: true })),
  ]);

  const record = records.find((candidate) => Number.parseInt(candidate.id ?? '', 10) === ticketId);
  if (rssResponse.status === 404) {
    if (record) {
      throw new ToolError(
        'upstream_error',
        `Trac returned inconsistent data for ticket ${ticketId}`
      );
    }
    throw new ToolError('not_found', `Ticket ${ticketId} not found`, {
      resource: 'ticket',
      id: ticketId,
    });
  }
  if (!rssResponse.ok) {
    throw upstreamHttpError(rssResponse);
  }
  if (!record) {
    throw new ToolError('upstream_error', `Trac returned inconsistent data for ticket ${ticketId}`);
  }

  const rssText = await rssResponse.text();
  const channel = rssText.split(/<item>/i, 1)[0] ?? '';
  const description = cleanTracText(readXmlText(channel, 'description'), instance.origin);
  const history = classifyTicketHistory(instance, ticketId, rssText);
  const limit = Math.min(Math.max(Math.trunc(commentLimit), 0), TICKET_COMMENT_LIMIT_MAX);
  const comments = includeComments && limit > 0 ? history.comments.slice(-limit) : [];
  const ticket = { ...ticketFromRecord(record), description };

  return {
    ticket,
    comments,
    totalComments: history.comments.length,
    linkedPullRequests: linkedPullRequestsResult.linkedPullRequests,
    linkedPullRequestsUnavailable: linkedPullRequestsResult.unavailable,
    attachments: history.attachments,
    changesets: history.changesets,
    omittedComments: history.omittedComments,
  };
}

function formatTicketResult(
  instance: TracInstance,
  ticketData: Awaited<ReturnType<typeof fetchTicket>>,
  includeComments: boolean,
  forChatGpt = false
) {
  const {
    ticket,
    comments,
    totalComments,
    linkedPullRequests,
    linkedPullRequestsUnavailable,
    attachments,
    changesets,
    omittedComments,
  } = ticketData;
  const historyText =
    includeComments && comments.length > 0
      ? `\n\nRecent comments:\n${comments
          .map((entry) => {
            const heading = [entry.timestamp, entry.author, entry.changes]
              .filter(Boolean)
              .join(' — ');
            return `${heading}\n${entry.comment}`.trim();
          })
          .join('\n\n')}`
      : '';
  const omittedText =
    includeComments && omittedComments.length > 0
      ? `\n\nOmitted comments: ${omittedComments
          .map((entry) => `${entry.id} (${entry.author}, ${entry.reason})`)
          .join('; ')}`
      : '';
  const linkedPullRequestsText = linkedPullRequestsUnavailable
    ? '\n\nLinked pull requests: unavailable'
    : linkedPullRequests.length
      ? `\n\nLinked pull requests:\n${linkedPullRequests
          .map((pullRequest) => {
            const checks = Object.entries(pullRequest.checkRuns)
              .map(([name, status]) => `${name}: ${status}`)
              .join(', ');
            const reviews = Object.entries(pullRequest.reviews)
              .map(([verdict, reviewers]) => `${verdict}: ${reviewers.join(', ')}`)
              .join('; ');
            return `${pullRequest.repository}#${pullRequest.number}: ${pullRequest.title}
State: ${pullRequest.state}
Author: ${pullRequest.author}
CI: ${checks || 'No check results'}
Reviews: ${reviews || 'No reviews'}
Touches tests: ${pullRequest.touchesTests ? 'yes' : 'no'}
Changes: +${pullRequest.additions}/-${pullRequest.deletions}
URL: ${pullRequest.url}

${pullRequest.body || 'No pull request description'}`;
          })
          .join('\n\n')}`
      : '';
  const attachmentsText = attachments.length
    ? `\n\nAttachments:\n${attachments
        .map((attachment) => {
          const details = [attachment.author, attachment.timestamp].filter(Boolean).join(' — ');
          const descriptionText = attachment.description ? `\n${attachment.description}` : '';
          return `- ${attachment.filename || '(unnamed)'}${details ? ` — ${details}` : ''}${attachment.url ? `\n  ${attachment.url}` : ''}${descriptionText}`;
        })
        .join('\n')}`
    : '';
  const changesetsText = changesets.length
    ? `\n\nChangesets:\n${changesets
        .map((changeset) => {
          const details = [changeset.author, changeset.timestamp].filter(Boolean).join(' — ');
          return `- r${changeset.revision}${details ? ` — ${details}` : ''}\n  ${changeset.url}${changeset.message ? `\n${changeset.message}` : ''}`;
        })
        .join('\n\n')}`
    : '';

  return {
    id: forChatGpt ? ticket.id.toString() : ticket.id,
    title: `#${ticket.id}: ${ticket.summary}`,
    text: `Ticket #${ticket.id}: ${ticket.summary}

Status: ${ticket.status}
Component: ${ticket.component}
Priority: ${ticket.priority}
Type: ${ticket.type}
Reporter: ${ticket.reporter}
Owner: ${ticket.owner}
Milestone: ${ticket.milestone}
Version: ${ticket.version}
Severity: ${ticket.severity}
Resolution: ${ticket.resolution}
Keywords: ${ticket.keywords}
Focuses: ${ticket.focuses}

Description:
${ticket.description}${forChatGpt ? `${linkedPullRequestsText}${attachmentsText}${changesetsText}${historyText}${omittedText}` : ''}`,
    url: `${instance.origin}/ticket/${ticket.id}`,
    metadata: {
      ticket,
      comments,
      totalComments,
      returnedComments: comments.length,
      omittedComments,
      linkedPullRequests,
      linkedPullRequestsUnavailable,
      attachments,
      changesets,
    },
  };
}

function changesetFetchError(revision: number, response: Response): ToolError {
  if (response.status === 404) {
    return new ToolError('not_found', `Changeset ${revision} not found`, {
      resource: 'changeset',
      id: revision,
    });
  }
  return upstreamHttpError(response);
}

async function fetchChangeset(
  instance: TracInstance,
  revision: number,
  includeDiff: boolean,
  diffLimit = 2000
) {
  const changesetUrl = `${instance.origin}/changeset/${revision}`;
  const response = await fetchTrac(instance, changesetUrl, {
    headers: { 'User-Agent': TRAC_USER_AGENT },
  });

  if (!response.ok) {
    throw changesetFetchError(revision, response);
  }

  const html = await response.text();
  const message = cleanTracText(
    html.match(/<dd class="message[^"]*"[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '',
    instance.origin
  );
  const author = cleanTracText(
    html.match(/<dd class="author"[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '',
    instance.origin
  );
  const date =
    cleanTracText(html.match(/<dd class="time"[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '', instance.origin)
      .split('\n')[0]
      ?.trim() ?? '';
  const filesSection = html.match(/<dd class="files"[^>]*>([\s\S]*?)<\/ul>\s*<\/dd>/i)?.[1] ?? '';
  const files = Array.from(
    filesSection.matchAll(/<a[^>]*href="\/browser\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi),
    (match) => cleanTracText(match[1] ?? '', instance.origin)
  ).filter(Boolean);

  let diff = '';
  if (includeDiff) {
    try {
      const diffResponse = await fetchTrac(instance, `${changesetUrl}?format=diff`, {
        headers: { 'User-Agent': TRAC_USER_AGENT },
      });
      if (diffResponse.ok) {
        diff = await diffResponse.text();
        const maxDiffLength = Math.min(Math.max(Math.trunc(diffLimit), 0), 10000);
        if (diff.length > maxDiffLength) {
          diff = `${diff.substring(0, maxDiffLength)}\n... [diff truncated] ...`;
        }
      }
    } catch (error) {
      console.warn('Failed to load diff:', error);
    }
  }

  return { revision, author, date, message, files, diff };
}

function formatChangesetResult(
  instance: TracInstance,
  changeset: Awaited<ReturnType<typeof fetchChangeset>>,
  prefixedId = false
) {
  const filesText = changeset.files.slice(0, 10).join('\n');
  const summary = changeset.message.split('\n')[0] || 'No message';
  return {
    id: prefixedId ? `r${changeset.revision}` : changeset.revision.toString(),
    title: `r${changeset.revision}: ${summary}`,
    text: `Changeset r${changeset.revision}
Author: ${changeset.author}
Date: ${changeset.date}

Message:
${changeset.message}

Files changed: ${changeset.files.length}
${filesText}${changeset.files.length > 10 ? '\n...' : ''}

${changeset.diff ? `Diff:\n${changeset.diff}` : 'No diff available'}`,
    url: `${instance.origin}/changeset/${changeset.revision}`,
    metadata: {
      changeset,
      totalFiles: changeset.files.length,
    },
  };
}

type TracInfoType =
  | 'components'
  | 'milestones'
  | 'priorities'
  | 'severities'
  | 'types'
  | 'statuses';

type TracInfoResult = { data: string[]; configured: boolean };

const TracFieldOptionsSchema = z.object({
  options: z.array(z.string()),
  optgroups: z.array(z.object({ options: z.array(z.string()) })).optional(),
});

async function fetchTracInfo(instance: TracInstance, type: TracInfoType): Promise<TracInfoResult> {
  const field = {
    components: 'component',
    severities: 'severity',
    milestones: 'milestone',
    priorities: 'priority',
    types: 'type',
    statuses: 'status',
  }[type];
  const response = await fetchTrac(instance, new URL(`${instance.origin}/query`), {
    headers: { 'User-Agent': TRAC_USER_AGENT },
  });
  if (!response.ok) {
    throw upstreamHttpError(response);
  }

  const html = await response.text();
  const configured = configuredTracFields(html);
  if (!configured) {
    throw new Error(`Trac did not return ${field} options`);
  }
  if (!configured.has(field)) {
    return { data: [], configured: false };
  }

  try {
    const json = html.match(/\bvar\s+properties\s*=\s*(\{(?:[^";]|"(?:\\.|[^"\\])*")*\})\s*;/)?.[1];
    const properties = z.record(z.string(), z.unknown()).parse(JSON.parse(json ?? ''));
    const { options, optgroups } = TracFieldOptionsSchema.parse(properties[field]);
    return {
      data: [...options, ...(optgroups ?? []).flatMap((group) => group.options)],
      configured: true,
    };
  } catch {
    throw new ToolError('upstream_error', `Trac did not return ${field} options`);
  }
}

type TimelineWindow = { from: string; to: string };
type TimelineContinuation = TimelineWindow & {
  author?: z.infer<typeof TimelineAuthorSchema> | z.infer<typeof TimelineAuthorSchema>[];
  limit: number;
};
type TimelineQuery = ReturnType<typeof resolveTimelineQuery>;

// `today` is read once per request and threaded through: resolving the window
// against a second clock reading could cross UTC midnight and stretch an
// already validated 90-day window past max_daysback, which Trac clamps in
// silence.
function resolveTimelineQuery(args: z.infer<typeof GetTimelineArgsSchema>, today: string) {
  if (args.to !== undefined && args.to > today) {
    throw new InvalidToolArgumentsError(`to must not be later than today (${today}): ${args.to}`);
  }

  const to = args.to ?? today;
  // days and the default window are inclusive day counts ending at `to`.
  const from = args.from ?? shiftTimelineDay(to, 1 - (args.days ?? TIMELINE_DEFAULT_WINDOW_DAYS));
  if (from < TIMELINE_EARLIEST_DATE) {
    throw new InvalidToolArgumentsError(
      `Timeline dates must not be earlier than ${TIMELINE_EARLIEST_DATE}: ${from}`
    );
  }
  const span = timelineDaySpan(from, to);
  if (span < 0) {
    throw new InvalidToolArgumentsError('from must not be later than to');
  }
  if (span > TIMELINE_MAX_WINDOW_DAYS) {
    throw new InvalidToolArgumentsError(
      `The from-to window may span at most ${TIMELINE_MAX_WINDOW_DAYS} days per request; query adjacent ranges for longer periods`
    );
  }

  return {
    requested: { from, to } satisfies TimelineWindow,
    today,
    author: args.author,
    authors: typeof args.author === 'string' ? [args.author] : (args.author ?? []),
    limit: args.limit,
  };
}

function timelineEventDay(date: string): string {
  const timestamp = Date.parse(date);
  return Number.isNaN(timestamp) ? '' : timelineDay(timestamp);
}

function parseTimelineItems(rssText: string, origin: string): RssItem[] {
  if (/<!doctype html|<html/i.test(rssText)) {
    throw new ToolError('upstream_error', 'Trac returned HTML instead of RSS');
  }
  const items = parseRssItems(rssText, origin);
  if (items.some((item) => Number.isNaN(Date.parse(item.date)))) {
    throw new Error('Trac timeline returned an event with a missing or invalid pubDate');
  }
  return items;
}

function formatTimelineEvents(items: RssItem[]) {
  return items.map((item, index) => ({
    id: item.link || `event-${index}`,
    title: item.title || 'Unknown Event',
    text: `${item.title || 'Unknown Event'}\n\nAuthor: ${item.author || 'Unknown'}\nDate: ${item.date}\n\n${item.description || 'No description available'}`,
    url: item.link,
    metadata: {
      date: item.date,
      author: item.author,
      description: item.description,
    },
  }));
}

function timelineNote(
  requested: TimelineWindow,
  covered: TimelineWindow | null,
  continueWith: TimelineWindow | undefined,
  cappedDay: string,
  today: string
): string {
  const sentences = [
    covered === null
      ? `No complete day is covered in the requested window ${requested.from} to ${requested.to}.`
      : continueWith === undefined && cappedDay === ''
        ? `Covered the full requested window ${covered.from} to ${covered.to}.`
        : `Covered ${covered.from} to ${covered.to} of the requested ${requested.from} to ${requested.to}.`,
  ];
  if (cappedDay !== '') {
    sentences.push(
      `${cappedDay} alone filled the ${TIMELINE_FETCH_MAX}-event fetch limit, so only its newest events are included and that day is incomplete.`
    );
  }
  if (continueWith !== undefined) {
    sentences.push(
      `Call getTimeline again with from ${continueWith.from} and to ${continueWith.to} for the rest.`
    );
  }
  if (covered?.to === today || cappedDay === today) {
    sentences.push("Today's events reflect the time of the request.");
  }

  return sentences.join(' ');
}

function timelineCoveredWindow(
  requested: TimelineWindow,
  coveredFrom: string,
  cappedDay: string
): TimelineWindow | null {
  return cappedDay === '' ? { from: coveredFrom, to: requested.to } : null;
}

function timelineContinuationEdge(covered: TimelineWindow | null, cappedDay: string): string {
  return covered === null ? cappedDay : covered.from;
}

function timelineTerminalTruncation(cappedDay: string, returned: number) {
  if (cappedDay === '') {
    return {};
  }
  return {
    terminalTruncation: {
      day: cappedDay,
      reason: 'single_day_fetch_limit',
      fetchLimit: TIMELINE_FETCH_MAX,
      returned,
      canContinueWithinDay: false,
    },
  };
}

function buildTimelineResult(instance: TracInstance, rawItems: RssItem[], query: TimelineQuery) {
  const { requested, today, author, authors, limit } = query;
  const truncated = rawItems.length >= TIMELINE_FETCH_MAX;
  const dated = rawItems.map((item) => ({ item, day: timelineEventDay(item.date) }));
  // The feed is newest-first, so the `to` edge is always complete and only the
  // oldest fetched day can have been cut in half by the fetch limit.
  const oldestFetchedDay = dated.at(-1)?.day ?? requested.from;
  let coveredFrom = requested.from;
  let cappedDay = '';
  if (truncated && oldestFetchedDay >= requested.to) {
    // Every fetched event landed on one day, so no complete day is available.
    cappedDay = requested.to;
    coveredFrom = requested.to;
  } else if (truncated && oldestFetchedDay >= requested.from) {
    // An older day than this one is missing outright, and this one is only
    // half fetched, so coverage starts the day after it.
    coveredFrom = shiftTimelineDay(oldestFetchedDay, 1);
  }

  // Post-filtering to the requested window makes the fetch immune to Trac's
  // daysback semantics: the upstream window only has to be generous.
  let events = dated.filter((event) => event.day >= coveredFrom && event.day <= requested.to);
  // limit is advisory because the day is the smallest unit Trac can address:
  // trim whole days from the oldest end, and keep one oversized day intact.
  while (events.length > limit) {
    const oldestDay = events.at(-1)?.day;
    if (oldestDay === undefined || oldestDay === events[0]?.day) {
      break;
    }
    events = events.filter((event) => event.day !== oldestDay);
    coveredFrom = shiftTimelineDay(oldestDay, 1);
  }

  const covered = timelineCoveredWindow(requested, coveredFrom, cappedDay);
  const continuationEdge = timelineContinuationEdge(covered, cappedDay);
  const continueWith: TimelineContinuation | undefined =
    continuationEdge > requested.from
      ? {
          from: requested.from,
          to: shiftTimelineDay(continuationEdge, -1),
          ...(author === undefined ? {} : { author }),
          limit,
        }
      : undefined;

  return {
    results: formatTimelineEvents(events.map(({ item }) => item)),
    returned: events.length,
    requested,
    covered,
    complete: cappedDay === '' && covered?.from === requested.from,
    ...(continueWith === undefined ? {} : { continueWith }),
    ...(authors.length > 0 ? { authors } : {}),
    ...timelineTerminalTruncation(cappedDay, events.length),
    note: timelineNote(requested, covered, continueWith, cappedDay, today),
    timelineUrl: `${instance.origin}/timeline`,
  };
}

async function fetchTimeline(instance: TracInstance, query: TimelineQuery) {
  const { requested, authors } = query;
  const timelineUrl = new URL(`${instance.origin}/timeline`);
  timelineUrl.searchParams.set('from', requested.to);
  // daysback counts whole days back from an inclusive `from` day, and Trac
  // clamps 0 to 1. One day of slack keeps the fetch generous in both cases;
  // buildTimelineResult filters the events back to the requested window.
  timelineUrl.searchParams.set(
    'daysback',
    (timelineDaySpan(requested.from, requested.to) + 1).toString()
  );
  timelineUrl.searchParams.set('max', TIMELINE_FETCH_MAX.toString());
  timelineUrl.searchParams.set('format', 'rss');
  timelineUrl.searchParams.set('ticket', 'on');
  timelineUrl.searchParams.set('ticket_details', 'on');
  timelineUrl.searchParams.set('repo-', 'on');
  if (authors.length > 0) {
    // Trac splits the authors filter on spaces unless the name is quoted, and
    // applies it before max truncates the feed.
    timelineUrl.searchParams.set(
      'authors',
      authors.map((name) => (name.includes(' ') ? `"${name}"` : name)).join(' ')
    );
  }

  const response = await fetchTrac(instance, timelineUrl, {
    headers: { 'User-Agent': TRAC_USER_AGENT },
  });
  if (!response.ok) {
    throw upstreamHttpError(response, `Failed to fetch timeline: ${response.statusText}`);
  }

  return buildTimelineResult(
    instance,
    parseTimelineItems(await response.text(), instance.origin),
    query
  );
}

async function fetchLegacyTimeline(instance: TracInstance, days: number, limit: number) {
  const timelineUrl = new URL(`${instance.origin}/timeline`);
  timelineUrl.searchParams.set('from', timelineDay(Date.now()));
  timelineUrl.searchParams.set('daysback', days.toString());
  timelineUrl.searchParams.set('max', limit.toString());
  timelineUrl.searchParams.set('format', 'rss');
  timelineUrl.searchParams.set('ticket', 'on');
  timelineUrl.searchParams.set('ticket_details', 'on');
  timelineUrl.searchParams.set('repo-', 'on');

  const response = await fetchTrac(instance, timelineUrl, {
    headers: { 'User-Agent': TRAC_USER_AGENT },
  });
  if (!response.ok) {
    throw upstreamHttpError(response, `Failed to fetch timeline: ${response.statusText}`);
  }

  const results = formatTimelineEvents(parseTimelineItems(await response.text(), instance.origin));
  return {
    results,
    totalEvents: results.length,
    daysBack: days,
    timelineUrl: `${instance.origin}/timeline`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function toolContent(result: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolErrorContent(error: unknown) {
  const toolError =
    error instanceof ToolError
      ? error
      : new ToolError(
          error instanceof InvalidToolArgumentsError ? 'invalid_argument' : 'upstream_error',
          errorMessage(error)
        );
  return toolContent(
    { code: toolError.code, error: toolError.message, ...toolError.details },
    true
  );
}

async function executeStandardTool(
  instance: TracInstance,
  name: string,
  input: unknown
): Promise<unknown> {
  switch (name) {
    case 'searchTickets': {
      const { query, limit, page, status, component, milestone, resolution } =
        SearchTicketsArgsSchema.parse(input ?? {});
      const search = await searchTracTickets(instance, query, limit, page, {
        status,
        component,
        milestone,
        resolution,
      });
      return {
        results: search.tickets.map((ticket) => ({
          id: ticket.id,
          title: ticket.summary,
          text: `#${ticket.id}: ${ticket.summary}\nStatus: ${ticket.status || 'unknown'}\nOwner: ${ticket.owner || 'unassigned'}\nType: ${ticket.type || 'unknown'}\nPriority: ${ticket.priority || 'unknown'}\nMilestone: ${ticket.milestone || 'none'}\nComponent: ${ticket.component || 'unknown'}`,
          url: `${instance.origin}/ticket/${ticket.id}`,
          metadata: {
            status: ticket.status,
            owner: ticket.owner,
            type: ticket.type,
            priority: ticket.priority,
            milestone: ticket.milestone,
            component: ticket.component,
          },
        })),
        query,
        totalFound: search.totalFound,
        returned: search.returned,
        page: search.page,
        pageSize: search.pageSize,
        hasMore: search.hasMore,
      };
    }

    case 'getTicket': {
      const { id, includeComments, commentLimit } = GetTicketArgsSchema.parse(input);
      return formatTicketResult(
        instance,
        await fetchTicket(instance, id, includeComments, commentLimit),
        includeComments
      );
    }

    case 'getChangeset': {
      const { revision, includeDiff, diffLimit } = GetChangesetArgsSchema.parse(input);
      return formatChangesetResult(
        instance,
        await fetchChangeset(instance, revision, includeDiff, diffLimit)
      );
    }

    case 'getTimeline': {
      const args = GetTimelineArgsSchema.parse(input ?? {});
      if (args.from === undefined && args.to === undefined && args.author === undefined) {
        return fetchLegacyTimeline(instance, args.days ?? TIMELINE_DEFAULT_WINDOW_DAYS, args.limit);
      }
      return fetchTimeline(instance, resolveTimelineQuery(args, timelineDay(Date.now())));
    }

    case 'getTracInfo': {
      const { type } = GetTracInfoArgsSchema.parse(input);
      const { data, configured } = await fetchTracInfo(instance, type);
      const tracName = tracDisplayName(instance);
      const heading = type.charAt(0).toUpperCase() + type.slice(1);
      const emptyText = configured
        ? `No ${type} found in ${tracName}.`
        : `${heading} are not available in ${tracName}.`;
      return {
        id: type,
        title: `${tracName} ${type}`,
        text: data.length
          ? `${heading} available in ${tracName}:\n\n${data.join('\n')}`
          : emptyText,
        url: `${instance.origin}/`,
        metadata: { type, data, total: data.length },
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const SERVER_VERSION = '1.2.0';

const STANDARD_TOOLS = [
  {
    name: 'searchTickets',
    description:
      'Search WordPress Trac tickets by keyword, ticket number, or filter expressions. Returns one page of ticket summaries (id, summary, owner, type, status, priority, milestone, component) with totalFound, page, pageSize, and hasMore. Plain keywords match the ticket summary only; use description~=text to search ticket bodies. Field values differ by Trac instance, so call getTracInfo for the components, milestones, priorities, severities, types, and statuses this instance configures.',
    inputSchema: SearchTicketsArgsSchema,
  },
  {
    name: 'getTicket',
    description:
      'Get a WordPress Trac ticket: its fields, full description, human comments (newest commentLimit of them, with totalComments and returnedComments), attachments, changesets that reference it, and linked GitHub pull requests with their check and review state. Bot comments and cc or keyword-only changes are omitted from comments.',
    inputSchema: GetTicketArgsSchema,
  },
  {
    name: 'getChangeset',
    description:
      'Get information about a specific WordPress code changeset/commit including commit message, author, and diff.',
    inputSchema: GetChangesetArgsSchema,
  },
  {
    name: 'getTimeline',
    description:
      'Get activity from the WordPress Trac timeline including tickets, commits, and other events. Calls that use only days and limit keep the original recent-activity response. Date-range or author-filtered calls report coverage in whole UTC days. When complete is false, use continueWith when present to walk further back. Supports historical dates from 2005-01-01, date ranges of at most 90 days per request, and server-side author filtering.',
    inputSchema: GetTimelineArgsSchema,
  },
  {
    name: 'getTracInfo',
    description:
      'Get WordPress Trac components, milestones, priorities, severities, ticket types, or statuses.',
    inputSchema: GetTracInfoArgsSchema,
  },
];

const CHATGPT_TOOLS = [
  {
    name: 'search',
    description: `Search WordPress Trac for tickets, changesets, and timeline activity.

Query Types:
- Ticket searches: Use keywords like "block editor", "media upload", "REST API" to find related tickets
- Specific tickets: Use ticket numbers like "#61234" or "61234" to find specific tickets
- Changesets: Use r-prefixed revision numbers like "r58504" to find code changes
- Recent activity: Use terms like "recent", "timeline", "latest" to see recent Trac activity
- Components: Search by component like "REST API", "Block Editor", "Media" to find tickets in that area`,
    inputSchema: ChatGptSearchArgsSchema,
  },
  {
    name: 'fetch',
    description: 'Retrieve detailed information about a specific WordPress Trac item by its ID.',
    inputSchema: ChatGptFetchArgsSchema,
  },
];

/**
 * Build the MCP server for one request, bound to the Trac instance its route names.
 *
 * @param route The resolved MCP route.
 * @return A server exposing the standard tools, or the ChatGPT search and fetch pair.
 */
function createTracServer({ instance, chatGpt }: McpRoute): McpServer {
  const server = new McpServer(
    { name: tracDisplayName(instance), version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: false } } }
  );
  const execute = chatGpt ? executeChatGptTool : executeStandardTool;
  for (const tool of chatGpt ? CHATGPT_TOOLS : STANDARD_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: unknown) => {
        try {
          return toolContent(await execute(instance, tool.name, args));
        } catch (error) {
          return toolErrorContent(error);
        }
      }
    );
  }
  return server;
}

async function searchTicketsForChatGPT(instance: TracInstance, query: string, limit: number) {
  const search = await searchTracTickets(instance, query, limit, 1);
  return {
    results: search.tickets.map((ticket) => ({
      id: ticket.id.toString(),
      title: `#${ticket.id}: ${ticket.summary}`,
      text: `Ticket #${ticket.id}: ${ticket.summary}\nStatus: ${ticket.status}\nType: ${ticket.type}\nPriority: ${ticket.priority}\nOwner: ${ticket.owner}\nMilestone: ${ticket.milestone}`,
      url: `${instance.origin}/ticket/${ticket.id}`,
      metadata: { ticket },
    })),
    totalFound: search.totalFound,
  };
}

async function getTicketForChatGPT(
  instance: TracInstance,
  ticketId: number,
  includeComments: boolean
) {
  const ticketData = await fetchTicket(instance, ticketId, includeComments);
  return formatTicketResult(instance, ticketData, includeComments, true);
}

async function getChangesetForChatGPT(
  instance: TracInstance,
  revision: number,
  includeDiff: boolean
) {
  const changeset = await fetchChangeset(instance, revision, includeDiff);
  return formatChangesetResult(instance, changeset, true);
}

async function getTimelineForChatGPT(instance: TracInstance, days: number, limit: number) {
  const { results } = await fetchLegacyTimeline(instance, days, limit);
  return { results };
}

async function runChatGptSearch(instance: TracInstance, query: string) {
  const trimmed = query.trim();

  // A direct lookup that misses is an empty result. Every other failure remains an error.
  const emptyResultForMiss = (error: unknown) => {
    if (!(error instanceof ToolError) || error.code !== 'not_found') {
      throw error;
    }
    return { results: [], query, totalFound: 0 };
  };

  if (/^#?\d+$/.test(trimmed)) {
    try {
      const ticket = await getTicketForChatGPT(
        instance,
        Number.parseInt(trimmed.replace('#', ''), 10),
        false
      );
      return { results: [ticket], query, totalFound: 1 };
    } catch (error) {
      return emptyResultForMiss(error);
    }
  }
  if (/^r\d+$/i.test(trimmed)) {
    try {
      const changeset = await getChangesetForChatGPT(
        instance,
        Number.parseInt(trimmed.slice(1), 10),
        false
      );
      return { results: [changeset], query, totalFound: 1 };
    } catch (error) {
      return emptyResultForMiss(error);
    }
  }
  if (/\b(recent|timeline|latest|activity)\b/i.test(trimmed)) {
    const timeline = await getTimelineForChatGPT(instance, 7, 20);
    return { results: timeline.results, query, totalFound: timeline.results.length };
  }

  const tickets = await searchTicketsForChatGPT(instance, query, 10);
  return { results: tickets.results, query, totalFound: tickets.totalFound };
}

async function executeChatGptTool(
  instance: TracInstance,
  name: string,
  input: unknown
): Promise<unknown> {
  switch (name) {
    case 'search': {
      const { query } = ChatGptSearchArgsSchema.parse(input);
      return runChatGptSearch(instance, query);
    }
    case 'fetch': {
      const { id } = ChatGptFetchArgsSchema.parse(input);
      return id.startsWith('r')
        ? getChangesetForChatGPT(instance, Number.parseInt(id.slice(1), 10), true)
        : getTicketForChatGPT(instance, Number.parseInt(id, 10), true);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Simple CSV parser helper
function parseCSVLine(line: string): string[] {
  return Array.from(line.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^",]*))/g), (match) =>
    (match[1] ?? match[2] ?? '').replace(/""/g, '"').trim()
  );
}

// WordPress.com styled landing page
function getLandingPage(url: URL, versionInfo?: { id: string; tag?: string; timestamp: string }) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WordPress Trac MCP Server</title>
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${url.origin}">
  <meta property="og:title" content="WordPress Trac MCP Server">
  <meta property="og:description" content="Model Context Protocol server for WordPress.org Trac integration">
  <meta property="og:image" content="${url.origin}/og-image.png">
  
  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="${url.origin}">
  <meta property="twitter:title" content="WordPress Trac MCP Server">
  <meta property="twitter:description" content="Model Context Protocol server for WordPress.org Trac integration">
  <meta property="twitter:image" content="${url.origin}/og-image.png">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #ffffff;
      max-width: 600px;
      margin: 0 auto;
      padding: 40px 20px;
    }
    
    h1 {
      font-family: 'EB Garamond', serif;
      font-weight: 500;
      font-size: 2.25rem;
      color: #1a1a1a;
      margin-bottom: 0.5rem;
    }
    
    h2 {
      font-family: 'EB Garamond', serif;
      font-weight: 500;
      font-size: 1.5rem;
      color: #1a1a1a;
      margin: 2rem 0 1rem 0;
    }
    
    h3 {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      font-weight: 600;
      font-size: 1.1rem;
      color: #1a1a1a;
      margin: 1.5rem 0 0.75rem 0;
    }
    
    p {
      margin-bottom: 1rem;
      color: #4a4a4a;
    }
    
    .subtitle {
      color: #666;
      margin-bottom: 2rem;
    }
    
    code {
      background: #f6f8fa;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
      font-size: 0.9em;
      color: #3f57e1;
    }
    
    .code-block {
      background: #f6f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
      padding: 1rem;
      margin: 1rem 0;
      overflow-x: auto;
    }
    
    .code-block code {
      background: none;
      padding: 0;
      color: #24292e;
    }
    
    .mcp-tool {
      margin-bottom: 0.75rem;
    }
    
    .mcp-tool code {
      font-weight: 600;
    }
    
    a {
      color: #3f57e1;
      text-decoration: none;
    }
    
    a:hover {
      text-decoration: underline;
    }

    .instances {
      width: 100%;
      border-collapse: collapse;
      margin: 1rem 0;
      font-size: 0.95rem;
    }

    .instances th,
    .instances td {
      text-align: left;
      padding: 0.5rem 0.75rem 0.5rem 0;
      border-bottom: 1px solid #e1e4e8;
    }

    .instances th {
      color: #666;
      font-weight: 600;
    }

    .contribute {
      margin-top: 2rem;
      padding: 1.5rem;
      background: #f6f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
    }

    .contribute h2 {
      margin-top: 0;
    }

    .contribute p:last-child {
      margin-bottom: 0;
    }
    
    .footer {
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid #e1e4e8;
      text-align: center;
      color: #666;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <h1>WordPress Trac MCP Server</h1>
  <p class="subtitle">Model Context Protocol server for WordPress.org Trac integration</p>
  
  <h2>Standard MCP Tools</h2>
  
  <div class="mcp-tool">
    <code>searchTickets</code> - Search for WordPress Trac tickets by keyword or filter
  </div>
  
  <div class="mcp-tool">
    <code>getTicket</code> - Get detailed information about a specific ticket
  </div>
  
  <div class="mcp-tool">
    <code>getChangeset</code> - Get information about a code changeset/commit
  </div>
  
  <div class="mcp-tool">
    <code>getTimeline</code> - Get recent activity from WordPress Trac
  </div>
  
  <div class="mcp-tool">
    <code>getTracInfo</code> - Get Trac metadata (components, milestones, priorities, severities)
  </div>

  <h2>ChatGPT Deep Research Tools</h2>
  
  <div class="mcp-tool">
    <code>search</code> - Intelligent search for tickets, changesets, and activity
  </div>
  
  <div class="mcp-tool">
    <code>fetch</code> - Get detailed information about specific items
  </div>
  
  <h2>Trac Instances</h2>
  <p>Each WordPress.org Trac gets its own endpoint. Connect to the one you need; connect to several to use more than one.</p>
  <table class="instances">
    <thead>
      <tr><th>Trac</th><th>Endpoint</th></tr>
    </thead>
    <tbody>
${Object.keys(TRAC_LABELS)
  .map((slug) => {
    const instance = makeTracInstance(slug);
    const endpoint = slug === 'core' ? '/mcp' : `/mcp/${slug}`;
    return `      <tr><td><a href="${instance.origin}/">${instance.label}</a></td><td><code>${url.origin}${endpoint}</code></td></tr>`;
  })
  .join('\n')}
    </tbody>
  </table>
  <p>Any other <code>&lt;slug&gt;.trac.wordpress.org</code> works the same way at <code>${url.origin}/mcp/&lt;slug&gt;</code>. Fields vary between instances: a Trac without severities or components reports them as unavailable rather than failing.</p>

  <h2>Configuration</h2>

  <h3>Standard MCP (Claude Desktop, etc.)</h3>
  <div class="code-block">
    <code>{
  "mcpServers": {
    "wordpress-trac": {
      "command": "npx",
      "args": ["mcp-remote", "${url.origin}/mcp"]
    },
    "wordpress-meta-trac": {
      "command": "npx",
      "args": ["mcp-remote", "${url.origin}/mcp/meta"]
    }
  }
}</code>
  </div>

  <h3>ChatGPT Deep Research</h3>
  <p>ChatGPT uses a different connection method:</p>
  <div class="code-block">
    <code>1. Open ChatGPT Settings → Connectors tab
2. Add Server → Import remote MCP server:
   ${url.origin}/mcp/chatgpt
3. Enable in Composer → Deep Research tool
4. Add as research source if needed</code>
  </div>
  <p>Other instances use <code>${url.origin}/mcp/&lt;slug&gt;/chatgpt</code>.</p>
  <p>See: <a href="https://platform.openai.com/docs/mcp#connect-in-chatgpt">ChatGPT MCP Documentation</a></p>

  <section class="contribute">
    <h2>Contribute</h2>
    <p>This server is open source. Report an issue or help improve the server, documentation, and tests.</p>
    <p><a href="https://github.com/WordPress/trac-mcp">View the source and contribute on GitHub</a></p>
  </section>
  
  <div class="footer">
    <p><a href="https://core.trac.wordpress.org/">WordPress Trac</a> • <a href="https://modelcontextprotocol.io/">MCP Docs</a> • an experiment by <a href="https://automattic.ai">A8C AI</a></p>
    ${
      versionInfo
        ? `<p style="margin-top: 0.5rem; font-size: 0.8rem; color: #999;">
      Version: <code style="font-size: 0.8rem;">${versionInfo.id.substring(0, 8)}</code>
      ${versionInfo.tag ? ` • Tag: <code style="font-size: 0.8rem;">${versionInfo.tag}</code>` : ''}
      • Deployed: ${new Date(versionInfo.timestamp).toLocaleString()}
    </p>`
        : ''
    }
  </div>
</body>
</html>
  `;
}

// Environment interface
interface Env {
  ENVIRONMENT?: string;
  CF_VERSION_METADATA?: {
    id: string;
    tag?: string;
    timestamp: string;
  };
}

const MCP_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
};

// Tool arguments are a few hundred bytes; the SDK's own body limit is skipped because we parse first.
const MCP_MAX_BODY_BYTES = 65_536;

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  id: string | number | null = null
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: { ...MCP_CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function jsonRpcRequestId(body: unknown): string | number | null {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Read a request body as text, stopping as soon as it exceeds a byte limit.
 *
 * @param request Incoming request.
 * @param limit Maximum body size in bytes.
 * @return The body text, or null when the body is larger than the limit.
 */
async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return '';
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

type McpRoute = {
  instance: TracInstance;
  chatGpt: boolean;
};

/**
 * Resolve an MCP endpoint path to the Trac instance and tool set it addresses.
 *
 * Recognises /mcp, /mcp/chatgpt, /mcp/<slug>, and /mcp/<slug>/chatgpt, where the
 * two slugless paths address core.
 *
 * @param pathname Request path.
 * @return The matched route, or null when the path is not an MCP endpoint.
 */
export function matchMcpRoute(pathname: string): McpRoute | null {
  const segments = pathname.split('/');
  if (segments[1] !== 'mcp' || segments.length > 4) {
    return null;
  }
  if (segments.length === 2) {
    return { instance: CORE_TRAC, chatGpt: false };
  }
  if (segments.length === 3 && segments[2] === 'chatgpt') {
    return { instance: CORE_TRAC, chatGpt: true };
  }
  if (segments.length === 4 && segments[3] !== 'chatgpt') {
    return null;
  }

  const instance = tracInstance(segments[2] ?? '');
  return instance ? { instance, chatGpt: segments.length === 4 } : null;
}

const modernMcpHandler = createMcpHandler(
  ({ requestInfo }) => {
    const route = requestInfo && matchMcpRoute(new URL(requestInfo.url).pathname);
    if (!route) {
      throw new Error('MCP request reached the handler without a route');
    }
    return createTracServer(route);
  },
  { legacy: 'reject' }
);

/**
 * Serve one handshake-era request statelessly, answering with plain JSON rather than SSE.
 *
 * @param route The resolved MCP route.
 * @param request The normalized HTTP request.
 * @param body The already-parsed JSON-RPC body.
 * @return The transport's response.
 */
async function serveLegacyMcpRequest(
  route: McpRoute,
  request: Request,
  body: unknown
): Promise<Response> {
  try {
    const server = createTracServer(route);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const teardown = () => Promise.allSettled([transport.close(), server.close()]);
    request.signal.addEventListener('abort', teardown, { once: true });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { parsedBody: body });
    } finally {
      request.signal.removeEventListener('abort', teardown);
      await teardown();
    }
  } catch {
    return jsonRpcErrorResponse(500, -32603, 'Internal server error', jsonRpcRequestId(body));
  }
}

async function handleMcpHttpRequest(route: McpRoute, request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: MCP_CORS_HEADERS });
  }
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...MCP_CORS_HEADERS, Allow: 'POST, OPTIONS' },
    });
  }

  const text = await readBoundedText(request, MCP_MAX_BODY_BYTES);
  if (text === null) {
    return jsonRpcErrorResponse(413, -32600, 'Request body too large');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonRpcErrorResponse(400, -32700, 'Parse error');
  }
  if (Array.isArray(body)) {
    return jsonRpcErrorResponse(400, -32600, 'Batch requests are not supported');
  }
  // The tools never change, and each listen stream would hold an isolate-wide subscription slot.
  if ((body as { method?: unknown } | null)?.method === 'subscriptions/listen') {
    return jsonRpcErrorResponse(404, -32601, 'Method not found', jsonRpcRequestId(body));
  }

  // Clients were served before without these headers, which the SDK transport requires.
  const headers = new Headers(request.headers);
  headers.set('Content-Type', 'application/json');
  const accept = headers.get('Accept') ?? '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    headers.set('Accept', 'application/json, text/event-stream');
  }
  const normalized = new Request(request.url, { method: 'POST', headers, signal: request.signal });

  const response = (await isLegacyRequest(normalized, body))
    ? await serveLegacyMcpRequest(route, normalized, body)
    : await modernMcpHandler.fetch(normalized, { parsedBody: body });

  const responseHeaders = new Headers(response.headers);
  for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) {
    responseHeaders.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

// Cloudflare Worker export
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Serve favicon
    if (url.pathname === '/favicon.ico') {
      // WordPress-style "W" favicon as base64
      const faviconBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAA7AAAAOwBeShxvQAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAKPSURBVFiFtZe/axRBFMc/s3t7d3kTc4kJRpRYiIiNjYWNhYWFhY2FQkD8AxRsbCwsLCxsLGwsLCwsLCwsLCwsLCwUBEEQBEEQBEEQRBAiRo3Jmcvd7u6MxezO7d7tXS7qg2GZN+/H973vvZlZoUBEROYlWJRgXoKzwDRQKXJTGgYBNAQ8lOCGgG0iogqz4DtJsCLBvAT7iqTPCo4I0JGgKkExJR7PB7kpQVfAtd9lnyYjAVYFuCZg+n8wT8N+CVoClPtCQIT5lEwlLl6XNbqxNnVZY0LWeKiPMq9RLzKvFOCOBDsKid/VR3iv26RvJ/p1m3v6KLUirFOQSccdqsF1BYoJRIS5DNGEzLChQ8oqJCXiqjDGrjjyYb3HNQqSNQqSFfIyiJFE31bD+NJyOanHuF8LaBQkLgJ4AlbTzCM8K6zQVyF9FQIgoLTdQLo2nfCEbjhLJbiJjBgAdBRoJJmH9qJGQfJC7+NROkL0iXArJhD7aKsqHQklFWKpEICKbeKYfiZRRIJJMxpEKkrSlcAGKgLMJMlExOhLEq6AqQLi88rjlXkzfmQAbQWRfJdWHscMdGSErELGCohXBNC2TNysGODRNa22DRKYMkKgglGRPg9VBxEBvCjAGUdAxzJxlIuZJqKIBD0VENEHICoKD4DjJjAPBKxHNYKdQkcRtYzL7i1NCvyNOUQ5XgKcBLoiMCJ1BdZ9uJzXagtFEAMD9INP3I/o+RM8CPWvQAOY62e7RsEOEfmzP8BB4DxwFJg1x9uJtdOLN2AzZ7wtosOjDcO2rwEFGoAIiJI6LNYPZZw7oqBvAD6aG4wCBp9t4xdOBu6YRquJsQAAAABJRU5ErkJggg==';
      const faviconBuffer = Uint8Array.from(atob(faviconBase64), (c) => c.charCodeAt(0));

      return new Response(faviconBuffer, {
        headers: {
          'Content-Type': 'image/x-icon',
          'Cache-Control': 'public, max-age=31536000',
        },
      });
    }

    // Generate OG image
    if (url.pathname === '/og-image.png') {
      const title = (url.searchParams.get('title') || 'WordPress Trac MCP Server')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      const subtitle = (
        url.searchParams.get('subtitle') ||
        'Model Context Protocol server for WordPress.org Trac integration'
      )
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

      // Create a WordPress-branded OG image
      const svg = `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <style>
              <![CDATA[
                @import url('https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;700&display=swap');
                .title { font-family: 'EB Garamond', serif; font-size: 48px; font-weight: 700; fill: white; }
                .subtitle { font-family: 'EB Garamond', serif; font-size: 24px; font-weight: 400; fill: rgba(255,255,255,0.9); }
              ]]>
            </style>
          </defs>
          
          <!-- WordPress Blue Background -->
          <rect width="1200" height="630" fill="#21759b"/>
          
          <!-- WordPress Icon in Upper Left -->
          <g transform="translate(60, 60) scale(0.8)">
            <g fill="white">
              <path d="m8.708 61.26c0 20.802 12.089 38.779 29.619 47.298l-25.069-68.686c-2.916 6.536-4.55 13.769-4.55 21.388z"/>
              <path d="m96.74 58.608c0-6.495-2.333-10.993-4.334-14.494-2.664-4.329-5.161-7.995-5.161-12.324 0-4.831 3.664-9.328 8.825-9.328.233 0 .454.029.681.042-9.35-8.566-21.807-13.796-35.489-13.796-18.36 0-34.513 9.42-43.91 23.688 1.233.037 2.395.063 3.382.063 5.497 0 14.006-.667 14.006-.667 2.833-.167 3.167 3.994.337 4.329 0 0-2.847.335-6.015.501l19.138 56.925 11.501-34.493-8.188-22.434c-2.83-.166-5.511-.501-5.511-.501-2.832-.166-2.5-4.496.332-4.329 0 0 8.679.667 13.843.667 5.496 0 14.006-.667 14.006-.667 2.835-.167 3.168 3.994.337 4.329 0 0-2.853.335-6.015.501l18.992 56.494 5.242-17.517c2.272-7.269 4.001-12.49 4.001-16.989z"/>
              <path d="m62.184 65.857-15.768 45.819c4.708 1.384 9.687 2.141 14.846 2.141 6.12 0 11.989-1.058 17.452-2.979-.141-.225-.269-.464-.374-.724z"/>
              <path d="m107.376 36.046c.226 1.674.354 3.471.354 5.404 0 5.333-.996 11.328-3.996 18.824l-16.053 46.413c15.624-9.111 26.133-26.038 26.133-45.426.001-9.137-2.333-17.729-6.438-25.215z"/>
              <path d="m61.262 0c-33.779 0-61.262 27.481-61.262 61.26 0 33.783 27.483 61.263 61.262 61.263 33.778 0 61.265-27.48 61.265-61.263-.001-33.779-27.487-61.26-61.265-61.26zm0 119.715c-32.23 0-58.453-26.223-58.453-58.455 0-32.23 26.222-58.451 58.453-58.451 32.229 0 58.45 26.221 58.45 58.451 0 32.232-26.221 58.455-58.45 58.455z"/>
            </g>
          </g>
          
          <!-- Title in Bottom Left -->
          <text x="60" y="520" class="title">${title}</text>
          
          <!-- Subtitle in Bottom Left -->
          <text x="60" y="560" class="subtitle">${subtitle}</text>
        </svg>
      `;

      return new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=31536000',
        },
      });
    }

    // Serve landing page at root
    if (url.pathname === '/') {
      const versionInfo = env.CF_VERSION_METADATA;
      return new Response(getLandingPage(url, versionInfo), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    // Handle MCP endpoints
    const mcpRoute = matchMcpRoute(url.pathname);
    if (mcpRoute) {
      return handleMcpHttpRequest(mcpRoute, request);
    }

    // Own the whole /mcp namespace, so a preflight cannot succeed on a path that then 404s.
    if (url.pathname.startsWith('/mcp/')) {
      return new Response('Not found', { status: 404, headers: MCP_CORS_HEADERS });
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
