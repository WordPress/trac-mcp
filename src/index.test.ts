import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  addTicketSearchQuery,
  cleanTracText,
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

afterEach(() => {
  vi.unstubAllGlobals();
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
      .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
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
        .mockResolvedValue(new Response('Unavailable', { status: 503, statusText: 'Unavailable' }))
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
    expect(body.result.content.at(0)?.text).toContain('Unavailable');
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
