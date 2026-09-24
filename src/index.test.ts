import { McpServer } from '@modelcontextprotocol/server';
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

type TimelineWindow = { from: string; to: string };
type TimelineContinuation = TimelineWindow & {
  author?: string | string[];
  limit: number;
};
type TimelineResult = {
  timelineUrl?: string;
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

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
};

function modernRequest(
  path: string,
  method: string,
  params: { name?: string; arguments?: unknown } = {},
  version = '2026-07-28'
) {
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': version,
        'Mcp-Method': method,
        ...(params.name === undefined ? {} : { 'Mcp-Name': params.name }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {},
    context
  );
}

async function invalidArgumentsText(response: Response): Promise<string> {
  const body = (await response.json()) as RpcBody;
  expect(body.error).toBeUndefined();
  expect(body.result.isError).toBe(true);
  return body.result.content.at(0)?.text ?? '';
}

async function callTimeline(args: Record<string, unknown>, path = '/mcp'): Promise<TimelineResult> {
  const response = await mcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTimeline', arguments: args },
    },
    path
  );
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

async function getTicketWithLinkedPullRequest(
  pullRequest = linkedPullRequestFixture(),
  viaChatGptFetch = false
) {
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

  const response = viaChatGptFetch
    ? await mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'fetch', arguments: { id: '65808' } },
        },
        '/mcp/chatgpt'
      )
    : await mcpRequest({
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Trac parsing', () => {
  it('strips tags and decodes HTML entities and invisible characters', () => {
    expect(cleanTracText('<p>It&#39;s clean</p>\u200B', CORE_TRAC.origin)).toBe("It's clean");
  });

  it('keeps escaped markup in a code span as text', () => {
    expect(cleanTracText('<p>Use <code>&lt;script&gt;</code> here.</p>', CORE_TRAC.origin)).toBe(
      'Use <script> here.'
    );
  });

  it('keeps an external link without its class or icon span', () => {
    expect(
      cleanTracText(
        '<p>See the <a class="ext-link" href="https://example.org/plugin"><span class="icon">\u200B</span>example plugin</a>.</p>',
        CORE_TRAC.origin
      )
    ).toBe('See the <a href="https://example.org/plugin">example plugin</a>.');
  });

  it('keeps an internal ticket link without its class or title', () => {
    expect(
      cleanTracText(
        '<p>In <a class="closed ticket" href="/ticket/58664" title="defect (bug): Adopt script helpers (closed: fixed)">#58664</a>.</p>',
        CORE_TRAC.origin
      )
    ).toBe('In <a href="https://core.trac.wordpress.org/ticket/58664">#58664</a>.');
  });

  it('resolves a relative href from a field change against the instance', () => {
    expect(
      cleanTracText(
        '<li><strong>description</strong> modified (<a href="/ticket/59446?action=diff&amp;version=6">diff</a>)</li>',
        CORE_TRAC.origin
      )
    ).toBe(
      '- description modified (<a href="https://core.trac.wordpress.org/ticket/59446?action=diff&version=6">diff</a>)'
    );
  });

  it('unwraps an anchor whose href is not an http or https URL', () => {
    expect(cleanTracText('<p><a href="javascript:alert(1)">run</a> it</p>', CORE_TRAC.origin)).toBe(
      'run it'
    );
  });

  it('drops an anchor that carries no href', () => {
    expect(cleanTracText('<p><a name="top"></a>Top</p>', CORE_TRAC.origin)).toBe('Top');
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

  it('maps negation operators onto the value prefixes Trac reads', () => {
    expect(parseTicketFilter('status!=closed')).toEqual(['status', '!closed']);
    expect(parseTicketFilter('keywords!~=needs-patch')).toEqual(['keywords', '!~needs-patch']);
    expect(() => parseTicketFilter('status<>closed')).toThrow('field!=value');
  });

  it('passes native Trac spellings and values containing = through unchanged', () => {
    expect(parseTicketFilter('status=!closed')).toEqual(['status', '!closed']);
    expect(parseTicketFilter('summary=~composer')).toEqual(['summary', '~composer']);
    expect(parseTicketFilter('description~=key=value')).toEqual(['description', '~key=value']);
    expect(parseTicketFilter('summary!=a=b')).toEqual(['summary', '!a=b']);
  });

  it('accepts order and desc as sort controls', () => {
    const url = new URL('https://core.trac.wordpress.org/query');
    addTicketSearchQuery(url, 'component=Editor&order=changetime&desc=1&order=priority');

    expect(url.searchParams.getAll('component')).toEqual(['Editor']);
    expect(url.searchParams.getAll('order')).toEqual(['priority']);
    expect(url.searchParams.get('desc')).toBe('1');
    expect(() => parseTicketFilter('order=bogus')).toThrow('Unsupported sort column');
    expect(() => parseTicketFilter('order~=changetime')).toThrow('Unsupported sort column');
    expect(() => parseTicketFilter('desc=yes')).toThrow('Unsupported desc value');
  });

  it('rejects repeated filters on one field with different operators', () => {
    const url = new URL('https://core.trac.wordpress.org/query');
    addTicketSearchQuery(
      url,
      'status=new&status=assigned&keywords=!has-patch&keywords!=needs-patch'
    );
    expect(url.searchParams.getAll('status')).toEqual(['new', 'assigned']);
    expect(url.searchParams.getAll('keywords')).toEqual(['!has-patch', '!needs-patch']);

    expect(() =>
      addTicketSearchQuery(
        new URL('https://core.trac.wordpress.org/query'),
        'status!=closed&status=new'
      )
    ).toThrow('same operator');
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
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
      'Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name'
    );
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

  it('serves a stateless 2026-07-28 client without a handshake', async () => {
    const response = await modernRequest('/mcp/meta/chatgpt', 'tools/list');
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['search', 'fetch']);
  });

  it('reads a stateless 2026-07-28 tool call from the instance its path names', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '<form id="query"><select name="add_filter_0"><option value="type"></option></select><script>var properties={"type":{"options":["defect"]}};</script></form>'
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await modernRequest('/mcp/meta', 'tools/call', {
      name: 'getTracInfo',
      arguments: { type: 'types' },
    });
    const body = (await response.json()) as RpcBody;

    expect(response.status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://meta.trac.wordpress.org');
    }
  });

  it('names its supported versions when a client asks for one it does not speak', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await modernRequest('/mcp', 'tools/list', {}, '2099-01-01');
    const body = (await response.json()) as {
      error: { code: number; data: { supported: string[] } };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain('2026-07-28');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a client that sends neither Accept nor Content-Type with plain JSON', async () => {
    const response = await worker.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      {},
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(((await response.json()) as RpcBody).error).toBeUndefined();
  });

  it('advertises the argument descriptions and read-only hints its Zod schemas carry', async () => {
    const response = await mcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const { tools } = (
      (await response.json()) as {
        result: {
          tools: Array<{
            name: string;
            annotations: { readOnlyHint: boolean };
            inputSchema: { properties: Record<string, { description?: string }> };
          }>;
        };
      }
    ).result;
    const search = tools.find((tool) => tool.name === 'searchTickets');

    const { query } = search?.inputSchema.properties ?? {};

    expect(query?.description).toContain('order=<column>');
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });

  it.each([
    ['a batch', [{ jsonrpc: '2.0', id: 1, method: 'ping' }], 400, -32600],
    [
      'a body over 64 KiB',
      { jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(70_000) },
      413,
      -32600,
    ],
  ])('refuses %s', async (_, body, status, code) => {
    const response = await mcpRequest(body);
    const payload = (await response.json()) as RpcBody & { id: unknown };

    expect(response.status).toBe(status);
    expect(payload.error.code).toBe(code);
    expect(payload.id).toBeNull();
  });

  it('closes a handshake-era server when its client disconnects mid-call', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', upstream);
    const close = vi.spyOn(McpServer.prototype, 'close');
    const controller = new AbortController();

    void worker.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'getTracInfo', arguments: { type: 'types' } },
        }),
        signal: controller.signal,
      }),
      {},
      context
    );
    await vi.waitFor(() => expect(upstream).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    controller.abort();

    await vi.waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('answers an internal failure on the handshake-era path as a JSON-RPC error', async () => {
    vi.spyOn(McpServer.prototype, 'connect').mockRejectedValueOnce(new Error('boom'));

    const response = await mcpRequest({ jsonrpc: '2.0', id: 42, method: 'tools/list' });
    const payload = (await response.json()) as RpcBody & { id: unknown };

    expect(response.status).toBe(500);
    expect(payload.error.code).toBe(-32603);
    expect(payload.id).toBe(42);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('does not open subscription streams for tools that never change', async () => {
    const listen = await modernRequest('/mcp', 'subscriptions/listen');
    const initialize = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: INITIALIZE_PARAMS,
    });

    const refusal = (await listen.json()) as RpcBody & { id: unknown };

    expect(listen.status).toBe(404);
    expect(refusal.error.code).toBe(-32601);
    expect(refusal.id).toBe(1);
    expect(
      (
        (await initialize.json()) as {
          result: { capabilities: { tools: { listChanged: boolean } } };
        }
      ).result.capabilities.tools.listChanged
    ).toBe(false);
  });

  it.each([
    ['tools/list', '2024-11-05'],
    ['tools/list', '2025-06-18'],
    ['initialize', '2025-06-18'],
  ])('serves %s with protocol version header %s', async (method, version) => {
    const response = await worker.fetch(
      new Request('https://example.com/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': version },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: method === 'initialize' ? INITIALIZE_PARAMS : {},
        }),
      }),
      {},
      context
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as RpcBody).result).toBeDefined();
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
    expect(await invalidArgumentsText(response)).toContain('Input validation error');
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

  it('accepts a commentLimit of 500 and rejects 501', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('Not Found', { status: 404 }))
    );

    const accepted = (await (
      await mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTicket', arguments: { id: 10931, commentLimit: 500 } },
      })
    ).json()) as RpcBody;
    const rejected = await mcpRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 10931, commentLimit: 501 } },
    });

    expect(accepted.error).toBeUndefined();
    expect(accepted.result.isError).toBe(true);
    expect(await invalidArgumentsText(rejected)).toContain('commentLimit');
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

  it('keeps a historical window on the connected instance', async () => {
    const fetchMock = stubTimelineFetch(timelineRss([['2005-01-31', 2]]));

    const result = await callTimeline({ from: '2005-01-31', to: '2005-01-31' }, '/mcp/meta');

    const fetched = new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '');
    expect(fetched.origin).toBe('https://meta.trac.wordpress.org');
    expect(result).toMatchObject({
      returned: 2,
      complete: true,
      timelineUrl: 'https://meta.trac.wordpress.org/timeline',
    });
  });

  it('keeps the recent-activity path on the connected instance', async () => {
    const fetchMock = stubTimelineFetch(timelineRss([['2026-08-05', 2]]));

    const result = await callTimeline({ days: 1, limit: 2 }, '/mcp/meta');

    expect(new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '').origin).toBe(
      'https://meta.trac.wordpress.org'
    );
    expect(result).toMatchObject({
      totalEvents: 2,
      daysBack: 1,
      timelineUrl: 'https://meta.trac.wordpress.org/timeline',
    });
  });

  it('keeps the ChatGPT recent-activity search on the connected instance', async () => {
    const fetchMock = stubTimelineFetch(timelineRss([['2026-08-05', 2]]));

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search', arguments: { query: 'recent activity' } },
      },
      '/mcp/meta/chatgpt'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    const requested = new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '');
    expect(requested.origin).toBe('https://meta.trac.wordpress.org');
    expect(requested.searchParams.get('max')).toBe('20');
  });

  it('reports an HTML body where the timeline RSS should be as an upstream error', async () => {
    stubTimelineFetch('<!DOCTYPE html><html><body>Service unavailable</body></html>');

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTimeline', arguments: { from: '2005-01-31', to: '2005-01-31' } },
    });
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}')).toMatchObject({
      code: 'upstream_error',
      error: 'Trac returned HTML instead of RSS',
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

    // The fetch asks for one day of slack, so post-filtering does the trimming.
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
    ['an empty author list', { author: [] }],
    ['days below the minimum', { days: 0 }],
    ['days above the maximum', { days: 31 }],
    ['limit below the minimum', { limit: 0 }],
    ['limit above the maximum', { limit: 101 }],
    ['a fractional limit', { limit: 1.5 }],
    ['an author longer than 50 characters', { author: 'a'.repeat(51) }],
    ['an unpadded date', { from: '2005-1-1' }, 'ISO-8601'],
    ['an eleventh author', { author: Array.from({ length: 11 }, (_, i) => `user${i}`) }],
  ])('rejects %s before an upstream request', async (_label, args, message?: string) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTimeline', arguments: args },
    });
    const text = await invalidArgumentsText(response);

    if (message !== undefined) {
      expect(text).toContain(message);
    }
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
    const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
    const author = {
      type: 'string',
      pattern: '^[A-Za-z0-9](?: ?[A-Za-z0-9@._-])*$',
      maxLength: 50,
    };

    // The boundaries here are the ones the "rejects %s" table proves the runtime enforces.
    expect(withoutDescriptions(advertised)).toEqual({
      days: { type: 'integer', minimum: 1, maximum: 30 },
      from: date,
      to: date,
      author: { anyOf: [author, { type: 'array', items: author, minItems: 1, maxItems: 10 }] },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    });
  });

  it.each([
    { name: 'getTicket', path: '/mcp', id: 65808, includesHistory: false },
    { name: 'fetch', path: '/mcp/chatgpt', id: '65808', includesHistory: true },
  ])(
    '$name includes history in text: $includesHistory',
    async ({ name, path, id, includesHistory }) => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response('id,summary,status\n65808,REST API ticket,closed'))
          .mockResolvedValueOnce(
            new Response(`<?xml version="1.0"?><rss><channel>
            <description>Ticket description</description>
            <item><dc:creator>reviewer</dc:creator><link>https://core.trac.wordpress.org/ticket/65808#comment:1</link><description>Useful review comment.</description></item>
          </channel></rss>`)
          )
          .mockResolvedValueOnce(Response.json([linkedPullRequestFixture()]))
      );

      const response = await mcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { id } },
        },
        path
      );
      const body = (await response.json()) as RpcBody;
      const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

      expect(result.id).toBe(id);
      expect(result.text).toContain('Ticket #65808: REST API ticket');
      expect(result.text).toContain('Description:\nTicket description');
      expect(result.metadata.comments).toEqual([
        expect.objectContaining({ comment: 'Useful review comment.' }),
      ]);
      expect(result.metadata.linkedPullRequests).toEqual([
        expect.objectContaining({ body: 'Pull request description' }),
      ]);
      expect(result.text.includes('Useful review comment.')).toBe(includesHistory);
      expect(result.text.includes('Pull request description')).toBe(includesHistory);
    }
  );

  it('includes linked pull request status, checks, reviews, and changes with a ticket', async () => {
    const { fetchMock, result } = await getTicketWithLinkedPullRequest(
      linkedPullRequestFixture(),
      true
    );

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
        body: 'Pull request description',
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
      const { result } = await getTicketWithLinkedPullRequest(
        linkedPullRequestFixture(overrides),
        true
      );

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

    const responseFromWorker = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fetch', arguments: { id: '65808' } },
      },
      '/mcp/chatgpt'
    );
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
      <item><dc:creator>committer</dc:creator><pubDate>Thu, 07 Nov 2024 16:03:41 GMT</pubDate><title>status changed; resolution set</title><link>https://core.trac.wordpress.org/ticket/65793#comment:4</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;status&lt;/strong&gt;         &lt;span class=&quot;trac-field-old&quot;&gt;new&lt;/span&gt; → &lt;span class=&quot;trac-field-new&quot;&gt;closed&lt;/span&gt;           &lt;/li&gt;&lt;li&gt;&lt;strong&gt;resolution&lt;/strong&gt;         → &lt;span class=&quot;trac-field-new&quot;&gt;fixed&lt;/span&gt;           &lt;/li&gt;&lt;/ul&gt;&lt;p&gt;In &lt;a class=&quot;changeset&quot; href=&quot;https://core.trac.wordpress.org/changeset/59369&quot;&gt;59369&lt;/a&gt;:&lt;/p&gt;&lt;div class=&quot;message&quot;&gt;&lt;p&gt;Backport message.&lt;/p&gt;&lt;/div&gt;</description></item>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:5</link><description>&lt;p&gt;Useful review comment.&lt;/p&gt;</description></item>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:01:00 GMT</pubDate><title>keywords set</title><link>https://core.trac.wordpress.org/ticket/65793#comment:6</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;keywords&lt;/strong&gt; needs-testing added&lt;/li&gt;&lt;/ul&gt;</description></item>
      <item><dc:creator>reporter</dc:creator><pubDate>Wed, 05 Aug 2026 19:02:00 GMT</pubDate><title>description changed</title><link>https://core.trac.wordpress.org/ticket/65793#description</link><description>&lt;p&gt;Ticket description repeated.&lt;/p&gt;</description></item>
      <item><dc:creator>slackbot</dc:creator><pubDate>Wed, 05 Aug 2026 19:03:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:7</link><description>&lt;p&gt;Slack mention.&lt;/p&gt;</description></item>
      <item><dc:creator>prbot</dc:creator><pubDate>Wed, 05 Aug 2026 19:04:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:8</link><description>&lt;p&gt;Pull request relay.&lt;/p&gt;</description></item>
      <item><dc:creator>watcher</dc:creator><pubDate>Wed, 05 Aug 2026 19:05:00 GMT</pubDate><title>cc set</title><link>https://core.trac.wordpress.org/ticket/65793#comment:9</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;cc&lt;/strong&gt; watcher added&lt;/li&gt;&lt;/ul&gt;</description></item>
      <item><dc:creator>reporter</dc:creator><pubDate>Wed, 05 Aug 2026 19:06:00 GMT</pubDate><title>description changed</title><link>https://core.trac.wordpress.org/ticket/65793#comment:10</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;description&lt;/strong&gt; modified (&lt;a href=&quot;/ticket/65793?action=diff&amp;amp;version=2&quot;&gt;diff&lt;/a&gt;)&lt;/li&gt;&lt;/ul&gt;</description></item>
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
        arguments: { id: 65793, includeComments: true, commentLimit: 2 },
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
        changes: 'status: new → closed; resolution: fixed',
        message: 'Backport message.',
        url: 'https://core.trac.wordpress.org/changeset/59369',
      }),
    ]);
    expect(result.metadata.comments).toEqual([
      expect.objectContaining({
        id: 6,
        author: 'reviewer',
        changes: 'keywords: needs-testing added',
        comment: '',
      }),
      expect.objectContaining({
        id: 10,
        author: 'reporter',
        changes:
          'description: modified (<a href="https://core.trac.wordpress.org/ticket/65793?action=diff&version=2">diff</a>)',
        comment: '',
      }),
    ]);
    expect(result.metadata.totalComments).toBe(3);
    expect(result.metadata.omittedComments).toEqual([
      { id: 7, author: 'slackbot', reason: 'bot' },
      { id: 8, author: 'prbot', reason: 'bot' },
      { id: 9, author: 'watcher', reason: 'cc' },
    ]);
    expect(result.text).not.toMatch(/Attachments:|Changesets:|Recent comments:|Omitted comments:/);

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65793,Accessibility ticket,new'))
        .mockResolvedValueOnce(new Response(rss))
    );
    const fetchResponse = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fetch', arguments: { id: '65793' } },
      },
      '/mcp/chatgpt'
    );
    const fetchBody = (await fetchResponse.json()) as RpcBody;
    const fetchResult = JSON.parse(fetchBody.result.content.at(0)?.text ?? '{}');

    expect(fetchResult.text).toContain('Attachments:');
    expect(fetchResult.text).toContain('Changesets:');
    expect(fetchResult.text).toContain('Recent comments:');
    expect(fetchResult.text).toContain(
      'Omitted comments: 7 (slackbot, bot); 8 (prbot, bot); 9 (watcher, cc)'
    );
    expect(fetchResult.text).not.toContain('Slack mention.');
    expect(fetchResult.text).not.toContain('Pull request relay.');
    expect(fetchResult.text).not.toContain('Ticket description repeated.');
  });

  it('keeps a bulleted list in a plain comment as prose, not field changes', async () => {
    const rss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <description>Ticket description</description>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title></title><link>https://core.trac.wordpress.org/ticket/65793#comment:3</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;status&lt;/strong&gt; should stay open&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;My recommendation.&lt;/p&gt;</description></item>
      <item><dc:creator>watcher</dc:creator><pubDate>Wed, 05 Aug 2026 19:01:00 GMT</pubDate><title>cc changed</title><link>https://core.trac.wordpress.org/ticket/65793#comment:4</link><description>&lt;p&gt;&lt;/p&gt;</description></item>
    </channel></rss>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n65793,Accessibility ticket,new'))
        .mockResolvedValueOnce(new Response(rss))
    );

    const response = await mcpRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'getTicket', arguments: { id: 65793, includeComments: true } },
    });
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.metadata.comments).toEqual([
      expect.objectContaining({
        id: 3,
        changes: '',
        comment: '- status should stay open\n\nMy recommendation.',
      }),
    ]);
    expect(result.metadata.omittedComments).toEqual([{ id: 4, author: 'watcher', reason: 'cc' }]);
  });

  it('classifies custom-field, empty, mixed-cc, and bot-authored history entries', async () => {
    const rss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <description>Ticket description</description>
      <item><dc:creator>triager</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title>customfield set</title><link>https://meta.trac.wordpress.org/ticket/5483#comment:10</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;customfield&lt;/strong&gt; → &lt;span class=&quot;trac-field-new&quot;&gt;x&lt;/span&gt;&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;note&lt;/p&gt;</description></item>
      <item><dc:creator>someone</dc:creator><pubDate>Wed, 05 Aug 2026 19:01:00 GMT</pubDate><title></title><link>https://meta.trac.wordpress.org/ticket/5483#comment:11</link><description>&lt;p&gt;&lt;/p&gt;</description></item>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:02:00 GMT</pubDate><title>cc, keywords changed</title><link>https://meta.trac.wordpress.org/ticket/5483#comment:12</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;cc&lt;/strong&gt; reviewer added&lt;/li&gt;&lt;li&gt;&lt;strong&gt;keywords&lt;/strong&gt; needs-patch added&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Needs a patch.&lt;/p&gt;</description></item>
      <item><dc:creator>prbot</dc:creator><pubDate>Wed, 05 Aug 2026 19:03:00 GMT</pubDate><title>keywords changed</title><link>https://meta.trac.wordpress.org/ticket/5483#comment:13</link><description>&lt;ul&gt;&lt;li&gt;&lt;strong&gt;keywords&lt;/strong&gt; has-patch added; needs-patch removed&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;&lt;em&gt;This ticket was mentioned in PR #1.&lt;/em&gt;&lt;/p&gt;</description></item>
    </channel></rss>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n5483,A meta ticket,new'))
        .mockResolvedValueOnce(new Response(rss))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTicket', arguments: { id: 5483, includeComments: true } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.metadata.comments).toEqual([
      expect.objectContaining({ id: 10, changes: 'customfield set' }),
      expect.objectContaining({
        id: 12,
        changes: 'keywords: needs-patch added',
        comment: 'Needs a patch.',
      }),
    ]);
    expect(result.metadata.comments[0].comment).toContain('customfield');
    expect(result.metadata.comments[0].comment).toContain('note');
    expect(result.metadata.omittedComments).toEqual([
      { id: 11, author: 'someone', reason: 'empty' },
      { id: 13, author: 'prbot', reason: 'bot' },
    ]);
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

  it('keeps comment links and resolves relative ones against the connected instance', async () => {
    const rss = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <description>&lt;p&gt;See &lt;a class=&quot;ext-link&quot; href=&quot;https://github.com/WordPress/wordpress-develop/pull/1&quot;&gt;&lt;span class=&quot;icon&quot;&gt;​&lt;/span&gt;existing PR&lt;/a&gt;.&lt;/p&gt;</description>
      <item><dc:creator>reviewer</dc:creator><pubDate>Wed, 05 Aug 2026 19:00:00 GMT</pubDate><title></title><link>https://meta.trac.wordpress.org/ticket/5483#comment:1</link><description>&lt;p&gt;Also &lt;a class=&quot;closed ticket&quot; href=&quot;/ticket/5480&quot; title=&quot;defect: something (closed: fixed)&quot;&gt;#5480&lt;/a&gt;.&lt;/p&gt;</description></item>
    </channel></rss>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary,status\n5483,Meta ticket,new'))
        .mockResolvedValueOnce(new Response(rss))
        .mockResolvedValueOnce(Response.json([]))
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTicket', arguments: { id: 5483, includeComments: true } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;
    const result = JSON.parse(body.result.content.at(0)?.text ?? '{}');

    expect(result.text).toContain(
      'See <a href="https://github.com/WordPress/wordpress-develop/pull/1">existing PR</a>.'
    );
    expect(result.metadata.comments).toEqual([
      expect.objectContaining({
        comment: 'Also <a href="https://meta.trac.wordpress.org/ticket/5480">#5480</a>.',
      }),
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
    expect(await invalidArgumentsText(response)).toContain('Input validation error');
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
      const response = await mcpRequest(
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS },
        path
      );

      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'WordPress Trac', version: '1.2.0' },
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
            '<html><body><select name="add_filter_0"><option value="severity">Severity</option></select><script>var properties={"severity":{"options":["blocker","normal"],"type":"select"}};</script></body></html>'
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
    const response = await mcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS },
      '/mcp/meta'
    );
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
    expect(JSON.parse(text).code).toBe('invalid_argument');
  });

  it('does not treat sort controls as filter fields the instance must configure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('id,summary\n5483,A meta ticket'))
      .mockResolvedValueOnce(
        new Response(
          '<html><select name="add_filter_0"><option value="status">Status</option></select><span class="numrows">(1 match)</span></html>'
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'searchTickets',
          arguments: { query: 'status!=closed&order=changetime&desc=1' },
        },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBeUndefined();
    const requested = new URL(fetchMock.mock.calls[0]?.[0]?.toString() ?? '');
    expect(requested.searchParams.get('status')).toBe('!closed');
    expect(requested.searchParams.get('order')).toBe('changetime');
    expect(requested.searchParams.get('desc')).toBe('1');
  });

  it('refuses a sort on a column the routed instance does not configure', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('id,summary\n5483,A meta ticket'))
        .mockResolvedValueOnce(
          new Response(
            '<html><select name="add_filter_0"><option value="status">Status</option></select><span class="numrows">(1 match)</span></html>'
          )
        )
    );

    const response = await mcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'searchTickets', arguments: { query: 'order=severity' } },
      },
      '/mcp/meta'
    );
    const body = (await response.json()) as RpcBody;

    expect(body.result.isError).toBe(true);
    const text = body.result.content.at(0)?.text ?? '';
    expect(text).toContain('has no severity field to sort by');
    expect(JSON.parse(text).code).toBe('invalid_argument');
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
    const text = body.result.content.at(0)?.text ?? '';
    expect(text).toContain('has no focuses field');
    expect(JSON.parse(text).code).toBe('invalid_argument');
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

  it.each([
    '',
    'var properties={broken};',
    'var properties={};',
    'var properties={"component":{"options":[42]}};',
    'var properties={"component":{"options":[],"optgroups":[{"options":"bad"}]}};',
  ])('reports unparseable configured options as upstream_error: %s', async (script) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            `<html><select name="add_filter_0"><option value="component">Component</option></select><script>${script}</script></html>`
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
    expect(JSON.parse(body.result.content.at(0)?.text ?? '{}').code).toBe('upstream_error');
  });

  it('reads options whatever order Trac writes the picker attributes in', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<html><select id="filter" name="add_filter_0"><option value="component">Component</option></select><script>var properties={"component":{"options":["Editor"],"type":"select"}};</script></html>'
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

  it.each([
    [
      'priorities',
      'priority',
      { type: 'select', options: ['highest omg bbq', 'high', 'normal', 'low', 'lowest'] },
      ['highest omg bbq', 'high', 'normal', 'low', 'lowest'],
    ],
    [
      'milestones',
      'milestone',
      {
        options: ['Unscheduled'],
        optgroups: [
          { label: 'Open (by due date)', options: ['7.0'] },
          { label: 'Open (no due date)', options: ['Future Release', 'Awaiting Review'] },
          { label: 'Closed', options: ['6.9', '6.8'] },
        ],
      },
      ['Unscheduled', '7.0', 'Future Release', 'Awaiting Review', '6.9', '6.8'],
    ],
    [
      'statuses',
      'status',
      { type: 'radio', options: ['approved', 'closed', 'new', 'reopened', 'reviewing'] },
      ['approved', 'closed', 'new', 'reopened', 'reviewing'],
    ],
    [
      'types',
      'type',
      { type: 'select', options: ['defect (bug)', 'enhancement'] },
      ['defect (bug)', 'enhancement'],
    ],
    [
      'components',
      'component',
      { options: ['Text }; "quoted"', 'Back\\slash', 'A & B'] },
      ['Text }; "quoted"', 'Back\\slash', 'A & B'],
    ],
  ])(
    'reads complete %s in Trac order from one query page',
    async (type, field, definition, expected) => {
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          `<select name="add_filter_0"><option value="${field}">${field}</option></select>
       <script>var properties = ${JSON.stringify({ [field]: definition }, null, 2)}; var other = {};</script>`
        )
      );
      vi.stubGlobal('fetch', upstream);

      const response = await mcpRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'getTracInfo', arguments: { type } },
      });
      const body = (await response.json()) as RpcBody;

      expect(body.result.isError).toBeUndefined();
      expect(JSON.parse(body.result.content.at(0)?.text ?? '{}').metadata.data).toEqual(expected);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(upstream.mock.calls[0]?.[0]?.toString()).toBe('https://core.trac.wordpress.org/query');
    }
  );

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

  it('separates an unconfigured field from one with no options', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            '<select name="add_filter_0"><option value="milestone">Milestone</option></select><script>var properties={"milestone":{"options":[]}};</script>'
          )
        )
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
