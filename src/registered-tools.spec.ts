import type { ChatTool } from '@spekoai/sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  mergeTools,
  RegisteredToolsLoader,
  type SerializedAgentTool,
  serializedToolToChatTool,
} from './registered-tools.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('serializedToolToChatTool', () => {
  it('maps a webhook tool to executionMode=webhook with the full source', () => {
    const tool: SerializedAgentTool = {
      id: 't_1',
      agentId: 'agent_1',
      name: 'lookup_order',
      description: 'Look up an order by id',
      parameters: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
      source: {
        kind: 'webhook',
        url: 'https://hooks.example.com/lookup',
        secretRef: 'webhook:agent_1:lookup_order',
        timeoutMs: 2000,
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(serializedToolToChatTool(tool)).toEqual({
      name: 'lookup_order',
      description: 'Look up an order by id',
      parameters: tool.parameters,
      executionMode: 'webhook',
      source: {
        kind: 'webhook',
        url: 'https://hooks.example.com/lookup',
        secretRef: 'webhook:agent_1:lookup_order',
        timeoutMs: 2000,
      },
    });
  });

  it('maps a builtin tool to executionMode=builtin', () => {
    const tool: SerializedAgentTool = {
      id: 't_2',
      agentId: 'agent_1',
      name: 'search_kb',
      description: 'Search the knowledge base',
      parameters: { type: 'object', properties: {} },
      source: { kind: 'builtin', name: 'search_knowledge_base' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(serializedToolToChatTool(tool)).toEqual({
      name: 'search_kb',
      description: 'Search the knowledge base',
      parameters: tool.parameters,
      executionMode: 'builtin',
      source: { kind: 'builtin', name: 'search_knowledge_base' },
    });
  });

  it('maps an inline tool with no executionMode override (server defaults to inline)', () => {
    const tool: SerializedAgentTool = {
      id: 't_3',
      agentId: 'agent_1',
      name: 'do_thing',
      description: 'Caller-executed thing',
      parameters: { type: 'object', properties: {} },
      source: { kind: 'inline' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(serializedToolToChatTool(tool)).toEqual({
      name: 'do_thing',
      description: 'Caller-executed thing',
      parameters: tool.parameters,
      executionMode: 'inline',
      // No `source` for inline — back-compat with v0.3 callers.
    });
  });

  it('preserves headers when present on a webhook source', () => {
    const tool: SerializedAgentTool = {
      id: 't_4',
      agentId: 'agent_1',
      name: 'h',
      description: 'd',
      parameters: { type: 'object' },
      source: {
        kind: 'webhook',
        url: 'https://h.example.com/x',
        secretRef: 'webhook:agent_1:h',
        headers: { 'x-trace-id': 'abc' },
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    const chat = serializedToolToChatTool(tool);
    expect(chat.source).toEqual({
      kind: 'webhook',
      url: 'https://h.example.com/x',
      secretRef: 'webhook:agent_1:h',
      headers: { 'x-trace-id': 'abc' },
    });
  });
});

describe('mergeTools', () => {
  it('returns just the registered tools when there are no runtime tools', () => {
    const registered: ChatTool[] = [
      {
        name: 'a',
        description: 'a',
        parameters: { type: 'object' },
        executionMode: 'webhook',
        source: {
          kind: 'webhook',
          url: 'https://example.com',
          secretRef: 'r',
        },
      },
    ];
    expect(mergeTools(registered, undefined)).toEqual(registered);
  });

  it('returns just the runtime tools when there are no registered tools', () => {
    const runtime: ChatTool[] = [{ name: 'b', description: 'b', parameters: { type: 'object' } }];
    expect(mergeTools(undefined, runtime)).toEqual(runtime);
  });

  it('returns undefined when both inputs are empty', () => {
    expect(mergeTools(undefined, undefined)).toBeUndefined();
    expect(mergeTools([], [])).toBeUndefined();
  });

  it('unions disjoint runtime + registered tools', () => {
    const registered: ChatTool[] = [
      {
        name: 'a',
        description: 'registered_a',
        parameters: { type: 'object' },
        executionMode: 'webhook',
        source: {
          kind: 'webhook',
          url: 'https://example.com',
          secretRef: 'r',
        },
      },
    ];
    const runtime: ChatTool[] = [
      { name: 'b', description: 'runtime_b', parameters: { type: 'object' } },
    ];
    const merged = mergeTools(registered, runtime);
    expect(merged).toHaveLength(2);
    const names = (merged ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('registered wins on name conflict and reports overrides', () => {
    const onOverride = vi.fn();
    const registered: ChatTool[] = [
      {
        name: 'send_email',
        description: 'registered',
        parameters: { type: 'object' },
        executionMode: 'webhook',
        source: {
          kind: 'webhook',
          url: 'https://hooks.example.com/email',
          secretRef: 'r',
        },
      },
    ];
    const runtime: ChatTool[] = [
      {
        name: 'send_email',
        description: 'runtime',
        parameters: { type: 'object' },
      },
    ];
    const merged = mergeTools(registered, runtime, { onOverride });
    expect(merged).toHaveLength(1);
    expect(merged?.[0]?.description).toBe('registered');
    expect(onOverride).toHaveBeenCalledWith('send_email');
  });
});

describe('RegisteredToolsLoader', () => {
  function makeLoader(opts: {
    fetchImpl: typeof fetch;
    baseUrl?: string;
    apiKey?: string;
    agentId?: string;
    onError?: (err: Error) => void;
  }): RegisteredToolsLoader {
    return new RegisteredToolsLoader({
      baseUrl: opts.baseUrl ?? 'https://api.example.com',
      apiKey: opts.apiKey ?? 'sk_test_key',
      agentId: opts.agentId ?? 'agent_test',
      fetchImpl: opts.fetchImpl,
      ...(opts.onError && { onError: opts.onError }),
    });
  }

  it('issues GET /v1/agents/:agentId/tools with bearer auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl, agentId: 'agent_42' });

    await loader.load();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.example.com/v1/agents/agent_42/tools');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk_test_key');
  });

  it('strips a trailing slash from baseUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const loader = makeLoader({
      fetchImpl,
      baseUrl: 'https://api.example.com/',
      agentId: 'a',
    });
    await loader.load();
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(url).toBe('https://api.example.com/v1/agents/a/tools');
  });

  it('caches: load() called twice triggers exactly one fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl });

    await loader.load();
    await loader.load();
    await loader.load();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('parallel callers share the in-flight request (single fetch)', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl });

    const p1 = loader.load();
    const p2 = loader.load();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse([]));

    await Promise.all([p1, p2]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns transformed ChatTool[] on success', async () => {
    const rows: SerializedAgentTool[] = [
      {
        id: 't1',
        agentId: 'agent_test',
        name: 'lookup_order',
        description: 'Look up an order',
        parameters: { type: 'object', properties: {} },
        source: {
          kind: 'webhook',
          url: 'https://hooks.example.com/lookup',
          secretRef: 'webhook:agent_test:lookup_order',
        },
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(rows)) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl });

    const tools = await loader.load();
    expect(tools).toHaveLength(1);
    expect(tools?.[0]?.name).toBe('lookup_order');
    expect(tools?.[0]?.executionMode).toBe('webhook');
    expect(tools?.[0]?.source).toEqual({
      kind: 'webhook',
      url: 'https://hooks.example.com/lookup',
      secretRef: 'webhook:agent_test:lookup_order',
    });
  });

  it('returns undefined and reports the error when fetch fails (network)', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl, onError });

    const tools = await loader.load();
    expect(tools).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/connection refused/);
  });

  it('returns undefined and reports the error on non-2xx HTTP', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'Invalid API key' }, 401),
    ) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl, onError });

    const tools = await loader.load();
    expect(tools).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/401/);
  });

  it('caches the error result too — failed load does not re-fetch every chat call', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const loader = makeLoader({ fetchImpl, onError });

    await loader.load();
    await loader.load();
    await loader.load();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
