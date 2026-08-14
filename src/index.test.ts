import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  addTicketSearchQuery,
  cleanTracText,
  fetchTrac,
  GetTimelineArgsSchema,
  parseCsvRecords,
  parseTicketFilter,
  searchTracTickets,
} from './index';

const context = {} as ExecutionContext;

type RpcBody = {
  error: { code: number };
  result: {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
};

type TimelineWindow = { from: string; to: string };
type TimelineContinuation = TimelineWindow & {
  author?: string | string[];
  limit: number;
};
type TimelineResult = {
  results: Array<{ url: string; metadata: { date: string; author: string } }>;
  returned?: number;
  requested?: TimelineWindow;
  covered?: TimelineWindow | null;
  complete?: boolean;
  continueWith?: TimelineContinuation;
  authors?: string[];
  note?: string;
  totalEvents?: number;
  daysBack?: number;
  terminalTruncation?: {
    day: string;
    reason: string;
    fetchLimit: number;
    returned: number;
    canContinueWithinDay: boolean;
  };
};

const EMPTY_RSS = '<?xml version="1.0"?><rss><channel></channel></rss>';

function mcpRequest(body: unknown, path = '/mcp') {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {},
    context
  );
}

async function callTimeline(args: Record<string, unknown>): Promise<TimelineResult> {
  const response = await mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'getTimeline', arguments: args },
  });
  const body = (await response.json()) as RpcBody;
  return JSON.parse(body.result.content.at(0)?.text ?? '{}');
}

// Newest-first changeset events, the shape core.trac's timeline RSS returns.
function timelineRss(days: Array<[day: string, count: number]>) {
  let revision = 60000;
  const items = days.flatMap(([day, count]) =>
    Array.from({ length: count }, () => {
      revision -= 1;
      return `<item>
        <title>Changeset [${revision}]</title>
        <dc:creator>saxmatt</dc:creator>
        <pubDate>${new Date(`${day}T12:00:00Z`).toUTCString()}</pubDate>
        <link>https://core.trac.wordpress.org/changeset/${revision}</link>
        <description>change on ${day}</description>
      </item>`;
    })
  );
  return `<?xml version="1.0"?><rss><channel>${items.join('')}</channel></rss>`;
}

function stubTimelineFetch(rss: string) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(rss));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function timelineParams(fetchMock: ReturnType<typeof stubTimelineFetch>) {
  return Object.fromEntries(new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '').searchParams);
}

function resultDays(result: TimelineResult) {
  return result.results.map((event) => new Date(event.metadata.date).toISOString().slice(0, 10));
}

type ZodCheck = { kind: string; value?: number; regex?: RegExp };
type ZodInternal = {
  _def: {
    typeName: string;
    innerType?: ZodInternal;
    schema?: ZodInternal;
    options?: ZodInternal[];
    type?: ZodInternal;
    shape?: () => Record<string, ZodInternal>;
    checks?: ZodCheck[];
    minLength?: { value: number } | null;
    maxLength?: { value: number } | null;
    defaultValue?: () => unknown;
  };
};

function zodCheck(def: ZodInternal['_def'], kind: string) {
  return def.checks?.find((check) => check.kind === kind);
}

function jsonSchemaFromZodNumber(def: ZodInternal['_def']) {
  const minimum = zodCheck(def, 'min')?.value;
  const maximum = zodCheck(def, 'max')?.value;
  return {
    type: zodCheck(def, 'int') === undefined ? 'number' : 'integer',
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

// Projects the runtime schema into the JSON Schema vocabulary tools/list uses,
// so the advertised constraints can be compared instead of the property names.
function jsonSchemaFromZod(schema: ZodInternal): Record<string, unknown> {
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodOptional':
      return jsonSchemaFromZod(def.innerType as ZodInternal);
    case 'ZodEffects':
      return jsonSchemaFromZod(def.schema as ZodInternal);
    case 'ZodDefault':
      return { ...jsonSchemaFromZod(def.innerType as ZodInternal), default: def.defaultValue?.() };
    case 'ZodUnion':
      return { anyOf: (def.options ?? []).map((option) => jsonSchemaFromZod(option)) };
    case 'ZodArray':
      return {
        type: 'array',
        items: jsonSchemaFromZod(def.type as ZodInternal),
        ...(def.minLength ? { minItems: def.minLength.value } : {}),
        ...(def.maxLength ? { maxItems: def.maxLength.value } : {}),
      };
    case 'ZodNumber': {
      return jsonSchemaFromZodNumber(def);
    }
    case 'ZodString': {
      const pattern = zodCheck(def, 'regex')?.regex?.source;
      const maxLength = zodCheck(def, 'max')?.value;
      return {
        type: 'string',
        ...(pattern === undefined ? {} : { pattern }),
        ...(maxLength === undefined ? {} : { maxLength }),
      };
    }
    default:
      throw new Error(`Unsupported Zod type: ${def.typeName}`);
  }
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutDescriptions);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'description')
      .map(([key, entry]) => [key, withoutDescriptions(entry)])
  );
}

function linkedPullRequestFixture(overrides: Record<string, unknown> = {}) {
  return {
    number: 12833,
    repo: 'WordPress/wordpress-develop',
    state: 'closed',
    title: 'REST API: Always register the media creation arguments',
    user: {
      name: 'contributor',
      url: 'https://github.com/contributor',
    },
    created_at: '2026-08-04T07:18:35Z',
    updated_at: '2026-08-05T06:41:21Z',
    closed_at: '2026-08-05T06:41:21Z',
    changes: {
      additions: 234,
      deletions: 45,
      patch_url: 'https://github.com/WordPress/wordpress-develop/pull/12833.diff',
      html_url: 'https://github.com/WordPress/wordpress-develop/pull/12833',
    },
    touches_tests: true,
    check_runs: { 'GitHub Actions': 'success' },
    reviews: { APPROVED: ['reviewer'] },
    mergeable_state: 'blocked',
    body: 'Pull request description',
    html_url: 'https://github.com/WordPress/wordpress-develop/pull/12833',
    ...overrides,
  };
}

async function getTicketWithLinkedPullRequest(pullRequest = linkedPullRequestFixture()) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
    .mockResolvedValueOnce(
      new Response(
        '<?xml version="1.0"?><rss><channel><description>Ticket description</description></channel></rss>'
      )
    )
    .mockResolvedValueOnce(Response.json([pullRequest]));
  vi.stubGlobal('fetch', fetchMock);

  const response = await mcpRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'getTicket',
      arguments: { id: 65808, includeComments: true, commentLimit: 10 },
    },
  });
  const body = (await response.json()) as RpcBody;

  return {
    fetchMock,
    result: JSON.parse(body.result.content.at(0)?.text ?? '{}'),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Trac parsing', () => {
  it('cleans nested HTML entities and invisible characters', () => {
    expect(cleanTracText('&lt;p&gt;It&#39;s clean&lt;/p&gt;\u200B')).toBe("It's clean");
  });

  it('parses quoted CSV fields', () => {
    expect(parseCsvRecords('id,summary\n123,"A comma, and ""quote"""')).toEqual([
      { id: '123', summary: 'A comma, and "quote"' },
    ]);
  });

  it('builds structured ticket filters safely', () => {
    const url = new URL('https://core.trac.wordpress.org/query');
    addTicketSearchQuery(url, 'summary~=composer&status=closed');

    expect(url.searchParams.get('summary')).toBe('~composer');
    expect(url.searchParams.get('status')).toBe('closed');
    expect(() => parseTicketFilter('bogusfield~=value')).toThrow('Unsupported ticket filter');
  });
});

describe('ticket search pagination', () => {
  it('returns an empty final page when Trac cannot render its HTML count view', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(''))
      .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchTracTickets('', 10, 85)).resolves.toEqual({
      tickets: [],
      totalFound: 840,
      returned: 0,
      page: 85,
      pageSize: 10,
      hasMore: false,
    });
  });
});

describe('Trac retries', () => {
  it('retries transport failures, rate limits, server failures, and bot challenges', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network reset'))
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('Unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('<html>Checking your browser</html>', { status: 403 }))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchTrac(
      'https://core.trac.wordpress.org/timeline',
      undefined,
      [0, 0, 0, 0]
    );

    expect(await response.text()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    [403, 'Forbidden'],
    [404, 'Not Found'],
  ])('does not retry a permanent HTTP %i response', async (status, statusText) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(statusText, { status, statusText }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchTrac('https://core.trac.wordpress.org/timeline', undefined, [0]);

    expect(response.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the final transient response after exhausting retries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchTrac('https://core.trac.wordpress.org/timeline', undefined, [0, 0]);

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses requests outside the fixed Trac origin', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTrac('https://example.com/timeline', undefined, [0])).rejects.toThrow(
      'Refusing non-Trac request host'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Landing page', () => {
  it('links the landing page to its source and contribution workflow', async () => {
    const response = await worker.fetch(new Request('https://example.com/'), {}, context);
    const html = await response.text();

    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(html).toContain('href="https://github.com/WordPress/trac-mcp"');
  });
});

describe('MCP transport', () => {
  it('answers endpoint preflight requests', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/mcp', { method: 'OPTIONS' }),
      {},
      context
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  });

  it('supports ping and initialized notifications', async () => {
    const ping = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(await ping.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });

    const initialized = await mcpRequest({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe('');
  });

  it('distinguishes malformed JSON from an invalid request', async () => {
    const malformed = await worker.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        body: '{',
      }),
      {},
      context
    );
    expect(((await malformed.json()) as RpcBody).error.code).toBe(-32700);

    const invalid = await mcpRequest({ jsonrpc: '2.0', id: 1 });
    expect(((await invalid.json()) as RpcBody).error.code).toBe(-32600);
  });

  it('rejects invalid tool arguments before an upstream request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTimeline',
        arguments: { days: '1&max=999999', limit: -2 },
      },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.error.code).toBe(-32602);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks upstream failures as tool errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTimeline',
        arguments: { days: 1, limit: 1 },
      },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('Forbidden');
  });

  it.each([7, 1])(
    'preserves the original recent-timeline contract for a %i-day request',
    async (days) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
      const fetchMock = stubTimelineFetch(timelineRss([['2026-08-05', 2]]));

      const result = await callTimeline({ days, limit: 2 });

      expect(timelineParams(fetchMock)).toEqual({
        from: '2026-08-05',
        daysback: days.toString(),
        max: '2',
        format: 'rss',
        ticket: 'on',
        ticket_details: 'on',
        'repo-': 'on',
      });
      expect(result).toMatchObject({ results: expect.any(Array), totalEvents: 2, daysBack: days });
      expect(result).not.toHaveProperty('returned');
      expect(result).not.toHaveProperty('requested');
      expect(result).not.toHaveProperty('covered');
      expect(result).not.toHaveProperty('complete');
    }
  );

  it('keeps the original recent-timeline defaults for a bare call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const fetchMock = stubTimelineFetch(EMPTY_RSS);

    const result = await callTimeline({});

    expect(timelineParams(fetchMock)).toMatchObject({ daysback: '7', max: '20' });
    expect(result).toMatchObject({ results: [], totalEvents: 0, daysBack: 7 });
    expect(result).not.toHaveProperty('complete');
  });

  it('uses whole-day coverage for a recent author-filtered request', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const fetchMock = stubTimelineFetch(EMPTY_RSS);

    const result = await callTimeline({ days: 7, author: 'saxmatt', limit: 20 });

    expect(timelineParams(fetchMock)).toMatchObject({
      from: '2026-08-05',
      daysback: '7',
      max: '500',
      authors: 'saxmatt',
    });
    expect(result).toMatchObject({
      requested: { from: '2026-07-30', to: '2026-08-05' },
      covered: { from: '2026-07-30', to: '2026-08-05' },
      complete: true,
    });
  });

  it.each([
    ['to alone', { to: '2026-08-03' }, { from: '2026-07-28', to: '2026-08-03' }],
    ['from alone', { from: '2026-08-03' }, { from: '2026-08-03', to: '2026-08-05' }],
  ])('resolves the window from %s', async (_label, args, requested) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    stubTimelineFetch(EMPTY_RSS);

    const result = await callTimeline(args);

    expect(result.requested).toEqual(requested);
  });

  it('requests a historical author-filtered timeline window', async () => {
    const fetchMock = stubTimelineFetch(EMPTY_RSS);

    const result = await callTimeline({
      from: '2005-01-01',
      to: '2005-01-31',
      author: ['saxmatt', 'spaced name'],
      limit: 100,
    });

    expect(timelineParams(fetchMock)).toEqual({
      from: '2005-01-31',
      daysback: '31',
      max: '500',
      format: 'rss',
      ticket: 'on',
      ticket_details: 'on',
      'repo-': 'on',
      authors: 'saxmatt "spaced name"',
    });
    expect(result).toMatchObject({
      results: [],
      returned: 0,
      requested: { from: '2005-01-01', to: '2005-01-31' },
      covered: { from: '2005-01-01', to: '2005-01-31' },
      complete: true,
      authors: ['saxmatt', 'spaced name'],
      note: 'Covered the full requested window 2005-01-01 to 2005-01-31.',
    });
  });

  it('excludes the previous day Trac leaks into a same-day window', async () => {
    const fetchMock = stubTimelineFetch(
      timelineRss([
        ['2005-01-31', 2],
        ['2005-01-30', 3],
      ])
    );

    const result = await callTimeline({ from: '2005-01-31', to: '2005-01-31' });

    // daysback=0 is clamped to 1 upstream, so post-filtering does the trimming.
    expect(timelineParams(fetchMock)).toMatchObject({ daysback: '1' });
    expect(resultDays(result)).toEqual(['2005-01-31', '2005-01-31']);
    expect(result).toMatchObject({
      returned: 2,
      covered: { from: '2005-01-31', to: '2005-01-31' },
      complete: true,
    });
  });

  it('drops the half-fetched oldest day when the fetch limit truncates the feed', async () => {
    stubTimelineFetch(
      timelineRss([
        ['2005-01-31', 5],
        ['2005-01-30', 5],
        ['2005-01-29', 490],
      ])
    );

    const result = await callTimeline({ from: '2005-01-01', to: '2005-01-31', limit: 100 });

    expect(new Set(resultDays(result))).toEqual(new Set(['2005-01-31', '2005-01-30']));
    expect(result).toMatchObject({
      returned: 10,
      requested: { from: '2005-01-01', to: '2005-01-31' },
      covered: { from: '2005-01-30', to: '2005-01-31' },
      complete: false,
      continueWith: { from: '2005-01-01', to: '2005-01-29', limit: 100 },
    });
    expect(result.note).toContain(
      'Call getTimeline again with from 2005-01-01 and to 2005-01-29 for the rest.'
    );
  });

  it('reports a complete window when truncation only reaches days before from', async () => {
    stubTimelineFetch(
      timelineRss([
        ['2005-01-31', 5],
        ['2005-01-30', 5],
        ['2005-01-29', 490],
      ])
    );

    const result = await callTimeline({ from: '2005-01-30', to: '2005-01-31', limit: 100 });

    expect(result).toMatchObject({
      returned: 10,
      covered: { from: '2005-01-30', to: '2005-01-31' },
      complete: true,
    });
    expect(result).not.toHaveProperty('continueWith');
  });

  it('trims whole days from the oldest end to honour the advisory limit', async () => {
    stubTimelineFetch(
      timelineRss([
        ['2005-01-31', 5],
        ['2005-01-30', 5],
        ['2005-01-29', 5],
      ])
    );

    const result = await callTimeline({ from: '2005-01-29', to: '2005-01-31', limit: 12 });

    expect(new Set(resultDays(result))).toEqual(new Set(['2005-01-31', '2005-01-30']));
    expect(result).toMatchObject({
      returned: 10,
      covered: { from: '2005-01-30', to: '2005-01-31' },
      complete: false,
      continueWith: { from: '2005-01-29', to: '2005-01-29', limit: 12 },
    });
  });

  it('resumes the same author-filtered query from continueWith unchanged', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          timelineRss([
            ['2005-01-31', 5],
            ['2005-01-30', 5],
            ['2005-01-29', 5],
          ])
        )
      )
      .mockResolvedValueOnce(
        new Response(
          timelineRss([
            ['2005-01-30', 5],
            ['2005-01-29', 5],
          ])
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const first = await callTimeline({
      from: '2005-01-29',
      to: '2005-01-31',
      author: 'saxmatt',
      limit: 6,
    });
    expect(first.continueWith).toEqual({
      from: '2005-01-29',
      to: '2005-01-30',
      author: 'saxmatt',
      limit: 6,
    });

    const second = await callTimeline(first.continueWith ?? {});

    expect(
      Object.fromEntries(new URL(fetchMock.mock.calls[1]?.[0]?.toString() ?? '').searchParams)
    ).toMatchObject({ from: '2005-01-30', daysback: '2', authors: 'saxmatt' });
    expect(second).toMatchObject({
      returned: 5,
      requested: { from: '2005-01-29', to: '2005-01-30' },
      covered: { from: '2005-01-30', to: '2005-01-30' },
      complete: false,
      continueWith: {
        from: '2005-01-29',
        to: '2005-01-29',
        author: 'saxmatt',
        limit: 6,
      },
      authors: ['saxmatt'],
    });
  });

  it.each([
    ['a single-day window', '2005-01-31', { from: '2005-01-31', to: '2005-01-31' }],
    ['the last day left after trimming', '2005-01-29', { from: '2005-01-31', to: '2005-01-31' }],
  ])('returns %s in full when one day exceeds the limit', async (_label, from, covered) => {
    stubTimelineFetch(
      timelineRss([
        ['2005-01-31', 5],
        ['2005-01-30', 5],
        ['2005-01-29', 5],
      ])
    );

    const result = await callTimeline({ from, to: '2005-01-31', limit: 2 });

    expect(resultDays(result)).toEqual(Array(5).fill('2005-01-31'));
    expect(result).toMatchObject({ returned: 5, covered });
  });

  it('warns when one day alone fills the fetch limit', async () => {
    stubTimelineFetch(timelineRss([['2005-01-31', 500]]));

    const result = await callTimeline({ from: '2005-01-29', to: '2005-01-31', limit: 100 });

    expect(result).toMatchObject({
      returned: 500,
      covered: null,
      complete: false,
      continueWith: { from: '2005-01-29', to: '2005-01-30', limit: 100 },
      terminalTruncation: {
        day: '2005-01-31',
        reason: 'single_day_fetch_limit',
        fetchLimit: 500,
        returned: 500,
        canContinueWithinDay: false,
      },
    });
    expect(result.note).toContain('No complete day is covered');
    expect(result.note).toContain(
      '2005-01-31 alone filled the 500-event fetch limit, so only its newest events are included and that day is incomplete.'
    );
  });

  it('offers no continuation when the only requested day fills the fetch limit', async () => {
    stubTimelineFetch(timelineRss([['2005-01-31', 500]]));

    const result = await callTimeline({ from: '2005-01-31', to: '2005-01-31', limit: 100 });

    expect(result).toMatchObject({
      returned: 500,
      covered: null,
      complete: false,
      terminalTruncation: {
        day: '2005-01-31',
        canContinueWithinDay: false,
      },
    });
    expect(result).not.toHaveProperty('continueWith');
  });

  it('returns malformed timeline dates as a tool error instead of incomplete success', async () => {
    stubTimelineFetch(`<?xml version="1.0"?><rss><channel><item>
      <title>Malformed event</title><dc:creator>saxmatt</dc:creator>
      <pubDate>not a date</pubDate><link>https://core.trac.wordpress.org/ticket/1</link>
      <description>bad upstream data</description>
    </item></channel></rss>`);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTimeline',
        arguments: { from: '2005-01-01', to: '2005-01-02' },
      },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('missing or invalid pubDate');
  });

  it.each([
    [
      'days combined with a date range',
      { days: 7, from: '2005-01-01' },
      'days cannot be combined with from or to',
    ],
    ['an impossible calendar date', { from: '2005-02-31' }, 'not a valid calendar date'],
    [
      'a date before WordPress Core Trac history',
      { from: '2004-12-31', to: '2005-01-01' },
      'must not be earlier than 2005-01-01',
    ],
    ['an end date in the future', { to: '2999-01-01' }, 'to must not be later than today'],
    [
      'an inverted date range',
      { from: '2005-03-01', to: '2005-01-01' },
      'from must not be later than to',
    ],
    [
      'a window wider than Trac can serve',
      { from: '2005-01-01', to: '2005-06-01' },
      'at most 90 days',
    ],
    ['an author using Trac exclusion syntax', { author: '-saxmatt' }, 'Authors must be'],
    ['an author with a trailing space', { author: 'saxmatt ' }, 'Authors must be'],
    ['an author with a doubled space', { author: 'spaced  name' }, 'Authors must be'],
    ['an empty author list', { author: [] }, 'at least 1 element'],
  ])('rejects %s before an upstream request', async (_label, args, message) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTimeline', arguments: args },
    });
    const body = (await response.json()) as RpcBody & { error: { message: string } };

    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toContain(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('advertises the getTimeline constraints its runtime schema enforces', async () => {
    const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const body = (await response.json()) as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      };
    };
    const advertised = body.result.tools.find((tool) => tool.name === 'getTimeline')?.inputSchema
      .properties;
    const shape = (GetTimelineArgsSchema as unknown as ZodInternal)._def.schema?._def.shape?.();

    expect(withoutDescriptions(advertised)).toEqual(
      Object.fromEntries(
        Object.entries(shape ?? {}).map(([name, member]) => [name, jsonSchemaFromZod(member)])
      )
    );
  });

  it('includes linked pull request status, checks, reviews, and changes with a ticket', async () => {
    const { fetchMock, result } = await getTicketWithLinkedPullRequest();

    expect(fetchMock.mock.calls[2]?.[0]?.toString()).toBe(
      'https://api.wordpress.org/dotorg/trac/pr/?trac=core&ticket=65808'
    );
    expect(result.metadata.linkedPullRequests).toEqual([
      expect.objectContaining({
        number: 12833,
        repository: 'WordPress/wordpress-develop',
        checkRuns: { 'GitHub Actions': 'success' },
        reviews: { APPROVED: ['reviewer'] },
        touchesTests: true,
        additions: 234,
        deletions: 45,
      }),
    ]);
    expect(result.metadata.linkedPullRequestsUnavailable).toBe(false);
    expect(result.text).toContain('Linked pull requests:');
    expect(result.text).toContain('CI: GitHub Actions: success');
    expect(result.text).toContain('Reviews: APPROVED: reviewer');
    expect(result.text).toContain('Pull request description');
  });

  it.each([
    {
      label: 'check list',
      overrides: { check_runs: [] },
      expectedCheckRuns: {},
      expectedReviews: { APPROVED: ['reviewer'] },
      expectedText: 'CI: No check results',
    },
    {
      label: 'review list',
      overrides: { reviews: [] },
      expectedCheckRuns: { 'GitHub Actions': 'success' },
      expectedReviews: {},
      expectedText: 'Reviews: No reviews',
    },
  ])(
    'normalizes an empty linked pull request $label',
    async ({ overrides, expectedCheckRuns, expectedReviews, expectedText }) => {
      const { result } = await getTicketWithLinkedPullRequest(linkedPullRequestFixture(overrides));

      expect(result.metadata.linkedPullRequests).toEqual([
        expect.objectContaining({
          checkRuns: expectedCheckRuns,
          reviews: expectedReviews,
        }),
      ]);
      expect(result.metadata.linkedPullRequestsUnavailable).toBe(false);
      expect(result.text).toContain(expectedText);
    }
  );

  it.each([
    [
      'an HTTP error',
      () => new Response('Unavailable', { status: 503, statusText: 'Unavailable' }),
    ],
    ['an unexpected response shape', () => Response.json([{ unexpected: 'shape' }])],
    [
      'a non-empty list for a record field',
      () => Response.json([linkedPullRequestFixture({ reviews: ['unexpected'] })]),
    ],
  ])('keeps the ticket available when linked pull requests return %s', async (_label, response) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
        .mockResolvedValueOnce(
          new Response(
            '<?xml version="1.0"?><rss><channel><description>Ticket description</description></channel></rss>'
          )
        )
        .mockResolvedValueOnce(response())
    );

    const responseFromWorker = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTicket',
        arguments: { id: 65808, includeComments: true, commentLimit: 10 },
      },
    });
    const body = (await responseFromWorker.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).not.toBe(true);
    expect(result.title).toBe('#65808: REST API ticket');
    expect(result.metadata.linkedPullRequests).toEqual([]);
    expect(result.metadata.linkedPullRequestsUnavailable).toBe(true);
    expect(result.text).toContain('Linked pull requests: unavailable');
  });

  it('separates attachments and changesets before limiting real comments', async () => {
    const rss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <description>Ticket description</description>
      <item><dc:creator>contributor</dc:creator><pubDate>Mon, 03 Aug 2026 10:42:01 GMT</pubDate><title>attachment set</title><link>https://core.trac.wordpress.org/ticket/65793</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;attachment&lt;/strong&gt; → &lt;span class=&quot;trac-field-new&quot;&gt;01 example.png&lt;/span&gt;&lt;/li&gt;&lt;/ul&gt;</description></item>
      <item><dc:creator>committer</dc:creator><pubDate>Thu, 07 Nov 2024 16:03:41 GMT</pubDate><title>status changed; resolution set</title><link>https://core.trac.wordpress.org/ticket/65793#comment:4</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;status&lt;/strong&gt; closed&lt;/li&gt;&lt;li&gt;&lt;strong&gt;resolution&lt;/strong&gt; fixed&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;In &lt;a class=&quot;changeset&quot; href=&quot;https://core.trac.wordpress.org/changeset/59369&quot;&gt;59369&lt;/a&gt;:&lt;/p&gt;&lt;div class=&quot;message&quot;&gt;&lt;p&gt;Backport message.&lt;/p&gt;&lt;/div&gt;</description></item>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:5</link><description>&lt;p&gt;Useful review comment.&lt;/p&gt;</description></item>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:01:00 GMT</pubDate><title>keywords set</title><link>https://core.trac.wordpress.org/ticket/65793#comment:6</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;keywords&lt;/strong&gt; needs-testing added&lt;/li&gt;&lt;/ul&gt;</description></item>
      <item><dc:creator>reporter</dc:creator><pubDate>Wed, 05 Aug 2026 19:02:00 GMT</pubDate><title>description changed</title><link>https://core.trac.wordpress.org/ticket/65793#description</link><description>&lt;p&gt;Ticket description repeated.&lt;/p&gt;</description></item>
      <item><dc:creator>slackbot</dc:creator><pubDate>Wed, 05 Aug 2026 19:03:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:7</link><description>&lt;p&gt;Slack mention.&lt;/p&gt;</description></item>
      <item><dc:creator>prbot</dc:creator><pubDate>Wed, 05 Aug 2026 19:04:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:8</link><description>&lt;p&gt;Pull request relay.&lt;/p&gt;</description></item>
    </channel></rss>`;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('id,summary,status\n65793,Accessibility ticket,new'))
      .mockResolvedValueOnce(new Response(rss));
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTicket',
        arguments: { id: 65793, includeComments: true, commentLimit: 1 },
      },
    });
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.metadata.attachments).toEqual([
      expect.objectContaining({
        filename: '01 example.png',
        url: 'https://core.trac.wordpress.org/raw-attachment/ticket/65793/01%20example.png',
      }),
    ]);
    expect(result.metadata.changesets).toEqual([
      expect.objectContaining({
        revision: 59369,
        message: 'Backport message.',
        url: 'https://core.trac.wordpress.org/changeset/59369',
      }),
    ]);
    expect(result.metadata.comments).toEqual([
      expect.objectContaining({ id: 5, author: 'reviewer', comment: 'Useful review comment.' }),
    ]);
    expect(result.metadata.totalComments).toBe(1);
    expect(result.text).toContain('Attachments:');
    expect(result.text).toContain('Changesets:');
    expect(result.text).toContain('Recent comments:');
    expect(result.text).not.toContain('Slack mention.');
    expect(result.text).not.toContain('Pull request relay.');
    expect(result.text).not.toContain('Ticket description repeated.');
  });

  it('requires an r prefix for changesets on the compatibility endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fetch', arguments: { id: 'not-a-revision' } },
      },
      '/mcp/chatgpt'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.error.code).toBe(-32602);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['99999999', 'r99999999'])(
    'returns no search matches when direct lookup %s does not exist',
    async (query) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' }))
      );

      const response = await mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query } },
        },
        '/mcp/chatgpt'
      );
      const body = (await response.json()) as RpcBody;
      const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

      expect(body.result.isError).toBeUndefined();
      expect(result).toEqual({ results: [], query, totalFound: 0 });
    }
  );
});
