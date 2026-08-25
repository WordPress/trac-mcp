import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  addTicketSearchQuery,
  cleanTracText,
  CORE_TRAC,
  fetchTrac,
  matchMcpRoute,
  parseCsvRecords,
  parseTicketFilter,
  searchTracTickets,
  tracInstance,
} from './index';

const context = {} as ExecutionContext;

type RpcBody = {
  error: { code: number };
  result: {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
};

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
  it('strips tags and decodes HTML entities and invisible characters', () => {
    expect(cleanTracText('<p>It&#39;s clean</p>\u200B')).toBe("It's clean");
  });

  it('keeps escaped markup in a code span as text', () => {
    expect(cleanTracText('<p>Use <code>&lt;script&gt;</code> here.</p>')).toBe(
      'Use <script> here.'
    );
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

    await expect(searchTracTickets(CORE_TRAC, '', 10, 85)).resolves.toEqual({
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
      CORE_TRAC,
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

    const response = await fetchTrac(
      CORE_TRAC,
      'https://core.trac.wordpress.org/timeline',
      undefined,
      [0]
    );

    expect(response.status).toBe(status);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns the final transient response after exhausting retries', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchTrac(
      CORE_TRAC,
      'https://core.trac.wordpress.org/timeline',
      undefined,
      [0, 0]
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses requests outside the fixed Trac origin', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchTrac(CORE_TRAC, 'https://example.com/timeline', undefined, [0])
    ).rejects.toThrow('Refusing non-Trac request host');
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
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBe(true);
    expect(result.code).toBe('upstream_error');
    expect(result.error).toContain('Forbidden');
  });

  it('requests timeline activity ending today across ticket and repository events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'));
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<?xml version="1.0"?><rss><channel></channel></rss>'));
    vi.stubGlobal('fetch', fetchMock);

    await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTimeline',
        arguments: { days: 7, limit: 20 },
      },
    });

    const timelineUrl = new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '');
    expect(Object.fromEntries(timelineUrl.searchParams)).toEqual({
      from: '2026-08-05',
      daysback: '7',
      max: '20',
      format: 'rss',
      ticket: 'on',
      ticket_details: 'on',
      'repo-': 'on',
    });
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

  it('keeps escaped markup in the description and in comments', async () => {
    const rss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <description>&lt;p&gt;Sample: &lt;code&gt;&amp;lt;script&amp;gt;&lt;/code&gt;&lt;/p&gt;</description>
      <item><dc:creator>reporter</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title>status changed</title><link>https://core.trac.wordpress.org/ticket/51407#comment:2</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;status&lt;/strong&gt; closed&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Also &lt;code&gt;&amp;lt;script&amp;gt;&lt;/code&gt;.&lt;/p&gt;</description></item>
    </channel></rss>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n51407,Script tag ticket,closed'))
        .mockResolvedValueOnce(new Response(rss))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'getTicket',
        arguments: { id: 51407, includeComments: true, commentLimit: 10 },
      },
    });
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.text).toContain('Sample: <script>');
    expect(result.metadata.comments).toEqual([
      expect.objectContaining({ id: 2, comment: 'Also <script>.' }),
    ]);
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

  it('returns a not_found code for a missing ticket', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n'))
        .mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }))
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 99999999 } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'not_found',
      error: 'Ticket 99999999 not found',
      resource: 'ticket',
      id: 99999999,
    });
  });

  it('returns a not_found code for a missing changeset', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Not Found', { status: 404, statusText: 'Not Found' }))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getChangeset', arguments: { revision: 99999999, includeDiff: false } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'not_found',
      error: 'Changeset 99999999 not found',
      resource: 'changeset',
      id: 99999999,
    });
  });

  it('reports an upstream error when ticket CSV data is absent but history exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n'))
        .mockResolvedValueOnce(
          new Response(
            '<?xml version="1.0"?><rss><channel><description>Ticket description</description></channel></rss>'
          )
        )
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 99999999 } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'upstream_error',
      error: 'Trac returned inconsistent data for ticket 99999999',
    });
  });

  it('reports an upstream error when ticket CSV data exists but history is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
        .mockResolvedValueOnce(new Response('Not Found', { status: 404, statusText: 'Not Found' }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 65808 } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'upstream_error',
      error: 'Trac returned inconsistent data for ticket 65808',
    });
  });

  it('reports an upstream error, not a missing ticket, when the history fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 65808 } },
    });
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBe(true);
    expect(result.code).toBe('upstream_error');
    expect(result.error).toBe('HTTP 403: Forbidden');
  });

  it('returns a rate_limited code when Trac throttling outlasts the retries', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' })
        )
    );

    const responsePromise = mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getChangeset', arguments: { revision: 58504, includeDiff: false } },
    });
    await vi.runAllTimersAsync();
    const body = (await (await responsePromise).json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBe(true);
    expect(result.code).toBe('rate_limited');
    expect(result.error).toBe('HTTP 429: Too Many Requests');
  });

  it('returns an invalid_argument code for an unsupported search filter', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'searchTickets', arguments: { query: 'bogusfield~=value' } },
    });
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBe(true);
    expect(result.code).toBe('invalid_argument');
    expect(result.error).toBe('Unsupported ticket filter: bogusfield');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no search matches when an exact ticket does not exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n'))
        .mockResolvedValueOnce(new Response('', { status: 404, statusText: 'Not Found' }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: '99999999' } },
      },
      '/mcp/chatgpt'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBeUndefined();
    expect(result).toEqual({ results: [], query: '99999999', totalFound: 0 });
  });

  it('returns no search matches when an exact changeset does not exist', async () => {
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
        params: { name: 'search', arguments: { query: 'r99999999' } },
      },
      '/mcp/chatgpt'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBeUndefined();
    expect(result).toEqual({ results: [], query: 'r99999999', totalFound: 0 });
  });

  it('propagates an upstream error from an exact ticket search', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
        .mockResolvedValueOnce(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: '65808' } },
      },
      '/mcp/chatgpt'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'upstream_error',
      error: 'HTTP 403: Forbidden',
    });
  });

  it('propagates an upstream error from an exact changeset search', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Forbidden', { status: 403, statusText: 'Forbidden' }))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'r58504' } },
      },
      '/mcp/chatgpt'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      code: 'upstream_error',
      error: 'HTTP 403: Forbidden',
    });
  });
});

describe('Trac instance routing', () => {
  it.each([
    ['/mcp', 'core', false],
    ['/mcp/chatgpt', 'core', true],
    ['/mcp/meta', 'meta', false],
    ['/mcp/meta/chatgpt', 'meta', true],
    ['/mcp/glotpress', 'glotpress', false],
  ])('routes %s to the %s instance', (pathname, slug, chatGpt) => {
    expect(matchMcpRoute(pathname)).toEqual({
      instance: expect.objectContaining({
        slug,
        origin: `https://${slug}.trac.wordpress.org`,
      }),
      chatGpt,
    });
  });

  it.each([
    ['/mcp/', 'an empty slug'],
    ['/mcp/meta/', 'a trailing slash'],
    ['/mcp/meta/tools', 'an unknown trailing segment'],
    ['/mcp/meta/chatgpt/extra', 'an over-long path'],
    ['/mcp/chatgpt/chatgpt', 'the reserved chatgpt slug'],
    ['/mcp/Meta', 'an uppercase slug'],
    ['/mcp/meta.trac.wordpress.org', 'a dotted slug'],
    ['/mcp/%6Deta', 'a percent-encoded slug, which URL parsing leaves encoded'],
    ['/mcpx', 'a different path'],
    ['/', 'the landing page'],
  ])('refuses %s (%s)', (pathname) => {
    expect(matchMcpRoute(pathname)).toBeNull();
  });

  it('refuses reserved and malformed slugs', () => {
    expect(tracInstance('chatgpt')).toBeNull();
    expect(tracInstance('')).toBeNull();
    expect(tracInstance('-leading')).toBeNull();
    expect(tracInstance('trailing-')).toBeNull();
    expect(tracInstance('a'.repeat(33))).toBeNull();
    expect(tracInstance('meta')?.origin).toBe('https://meta.trac.wordpress.org');
  });

  it('answers an unroutable instance path with 404 rather than core data', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'ping' }, '/mcp/Meta');

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats an upstream redirect as an unknown instance instead of following it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: 'https://core.trac.wordpress.org/timeline' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const instance = tracInstance('xyzzy-nope');
    if (!instance) {
      throw new Error('A well-formed slug should resolve regardless of whether the Trac exists');
    }

    await expect(
      fetchTrac(instance, 'https://xyzzy-nope.trac.wordpress.org/timeline', undefined, [0, 0])
    ).rejects.toThrow('Unknown or unavailable Trac instance: xyzzy-nope');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  /*
   * A redirect only proves the instance is missing when it names a target off the
   * instance origin. Without a usable Location there is nothing to compare, so the
   * failure has to stay generic rather than claim the Trac does not exist.
   */
  it('reports a redirect with no Location header as an upstream failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 301 }));
    vi.stubGlobal('fetch', fetchMock);

    const instance = tracInstance('xyzzy-nope');
    if (!instance) {
      throw new Error('A well-formed slug should resolve regardless of whether the Trac exists');
    }

    await expect(
      fetchTrac(instance, 'https://xyzzy-nope.trac.wordpress.org/timeline', undefined, [0, 0])
    ).rejects.toThrow('Unexpected redirect from https://xyzzy-nope.trac.wordpress.org: HTTP 301');
  });

  it('serves core under its own name at both slugless endpoints', async () => {
    for (const path of ['/mcp', '/mcp/chatgpt']) {
      const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, path);

      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'WordPress Trac', version: '1.1.0' },
        },
      });
    }
  });

  it('names core in the tool output that carries an instance name', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<html><body><select name="add_filter_0"><option value="severity">Severity</option></select><select class="trac-filter" name="0_severity"><option value="blocker">blocker</option><option value="normal">normal</option></select></body></html>'
          )
        )
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTracInfo', arguments: { type: 'severities' } },
    });
    const body = (await response.json()) as RpcBody;

    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      id: 'severities',
      title: 'WordPress Trac severities',
      text: 'Severities available in WordPress Trac:\n\nblocker\nnormal',
      url: 'https://core.trac.wordpress.org/',
      metadata: { type: 'severities', data: ['blocker', 'normal'], total: 2 },
    });
  });

  it('names a non-core instance after its Trac', async () => {
    const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, '/mcp/meta');
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };

    expect(body.result.serverInfo.name).toBe('Making WordPress.org Trac');
  });

  it('reads tickets from the routed instance and its linked pull requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('id,summary,status\n5483,Release confirmations,new'))
      .mockResolvedValueOnce(
        new Response(
          '<?xml version="1.0"?><rss><channel><description>Meta ticket</description></channel></rss>'
        )
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTicket', arguments: { id: 5483 } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    const requested = fetchMock.mock.calls.map((call) => call[0]?.toString() ?? '');
    expect(requested[0]).toContain('https://meta.trac.wordpress.org/query');
    expect(requested[1]).toBe('https://meta.trac.wordpress.org/ticket/5483?format=rss');
    expect(requested[2]).toBe('https://api.wordpress.org/dotorg/trac/pr/?trac=meta&ticket=5483');
    expect(result.url).toBe('https://meta.trac.wordpress.org/ticket/5483');
  });

  it.each(['65739', 'r58504', 'editor'])(
    'surfaces an unknown instance for compatibility search %s rather than an empty result',
    async (query) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(null, {
            status: 301,
            headers: { location: 'https://core.trac.wordpress.org/query' },
          })
        )
      );

      const response = await mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search', arguments: { query } },
        },
        '/mcp/xyzzy-nope/chatgpt'
      );
      const body = (await response.json()) as RpcBody;

      expect(body.result.isError).toBe(true);
      expect(body.result.content.at(0)?.text).toContain('Unknown or unavailable Trac instance');
    }
  );

  it('still returns an empty compatibility search when a direct lookup simply misses', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n'))
        .mockResolvedValueOnce(new Response('', { status: 404, statusText: 'Not Found' }))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: '99999999' } },
      },
      '/mcp/meta/chatgpt'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toEqual({
      results: [],
      query: '99999999',
      totalFound: 0,
    });
  });

  it('answers every method on an unroutable instance path with 404', async () => {
    for (const method of ['POST', 'OPTIONS', 'GET']) {
      const response = await worker.fetch(
        new Request('https://example.com/mcp/Meta', { method }),
        {},
        context
      );

      expect(response.status).toBe(404);
    }
  });

  it('refuses a search filtering on a field the routed instance does not configure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('id,summary\n286473,A theme'))
      .mockResolvedValueOnce(
        new Response(
          '<html><select name="add_filter_0"><option value="status">Status</option><option value="keywords">Keywords</option></select><span class="numrows">(149 matches)</span></html>'
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { component: 'Widgets' } },
      },
      '/mcp/themes'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    const text = body.result.content.at(0)?.text ?? '';
    expect(text).toContain('has no component field');
    expect(text).toContain('keywords, status');
  });

  it('refuses a filter expression naming a field only other instances configure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary\n5483,A meta ticket'))
        .mockResolvedValueOnce(
          new Response(
            '<html><select name="add_filter_0"><option value="component">Component</option><option value="status">Status</option></select><span class="numrows">(1117 matches)</span></html>'
          )
        )
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { query: 'focuses~=accessibility' } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('has no focuses field');
  });

  it('allows a search filtering on a field the routed instance does configure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('id,summary,component\n5483,A meta ticket,Plugin Directory')
        )
        .mockResolvedValueOnce(
          new Response(
            '<html><select name="add_filter_0"><option value="component">Component</option></select><span class="numrows">(3 matches)</span></html>'
          )
        )
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { component: 'Plugin Directory' } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}').totalFound).toBe(3);
  });

  it('fails rather than reporting a configured field as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<html><select name="add_filter_0"><option value="component">Component</option></select><p>the option list moved</p></html>'
          )
        )
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTracInfo', arguments: { type: 'components' } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('Trac did not return component options');
  });

  it('reads the option list whatever order Trac writes the select attributes in', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<html><select id="filter" name="add_filter_0"><option value="component">Component</option></select><select class="trac-filter" id="c" name="0_component"><option value="Editor">Editor</option></select></html>'
          )
        )
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTracInfo', arguments: { type: 'components' } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}').metadata.data).toEqual(['Editor']);
  });

  it('reports a redirect that stays on the instance as a redirect, not a missing instance', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://meta.trac.wordpress.org/maintenance' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const instance = tracInstance('meta');
    if (!instance) {
      throw new Error('meta should resolve');
    }

    await expect(
      fetchTrac(instance, 'https://meta.trac.wordpress.org/timeline', undefined, [0])
    ).rejects.toThrow('Unexpected redirect from https://meta.trac.wordpress.org: HTTP 302');
  });

  it('fails a filtered search when the count page cannot confirm the field exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary\n286473,A theme'))
        .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { component: 'Widgets' } },
      },
      '/mcp/themes'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('Cannot confirm the component filter');
  });

  it('still degrades gracefully when the count page fails and nothing was filtered', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary\n286473,A theme'))
        .mockResolvedValueOnce(new Response('Bad Request', { status: 400 }))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { limit: 5 } },
      },
      '/mcp/themes'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}').returned).toBe(1);
  });

  it('separates a field an instance lacks from one no ticket has a value for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('id,milestone\n4,\n5,'))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTracInfo', arguments: { type: 'milestones' } },
      },
      '/mcp/gsoc'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.metadata.data).toEqual([]);
    expect(result.text).toBe('No milestones found in Google Summer of Code Trac.');
  });

  it('follows a redirect from the linked pull request endpoint', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
      .mockResolvedValueOnce(
        new Response(
          '<?xml version="1.0"?><rss><channel><description>Ticket description</description></channel></rss>'
        )
      )
      .mockResolvedValueOnce(Response.json([linkedPullRequestFixture()]));
    vi.stubGlobal('fetch', fetchMock);

    await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 65808 } },
    });

    expect(fetchMock.mock.calls[2]?.[0]?.toString()).toContain('api.wordpress.org');
    expect(fetchMock.mock.calls[2]?.[1]?.redirect).toBeUndefined();
  });

  it('reports a field the routed instance does not configure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<html><body><select name="add_filter_0"><option value="status">Status</option></select></body></html>'
          )
        )
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTracInfo', arguments: { type: 'severities' } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(body.result.isError).toBeUndefined();
    expect(result.metadata.data).toEqual([]);
    expect(result.text).toBe('Severities are not available in Making WordPress.org Trac.');
  });

  it('still fails when a field page is not a Trac query page at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('<html><body>Maintenance</body></html>'))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTracInfo', arguments: { type: 'severities' } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(body.result.content.at(0)?.text).toContain('Trac did not return severity options');
  });
});
