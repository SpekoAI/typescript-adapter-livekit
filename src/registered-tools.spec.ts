import type { ChatTool, Speko } from '@spekoai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { mergeTools, RegisteredToolsLoader } from './registered-tools.js';

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
  /**
   * Build a loader backed by a fake `Speko` whose only exercised surface is
   * `agents.tools.listChatTools`. The conversion of rows → ChatTool[] lives in
   * the SDK now (and is tested there); the loader's job is caching, the hard
   * timeout, and soft-degradation on failure.
   */
  function makeLoader(opts: {
    listChatTools: (agentId: string, signal?: AbortSignal) => Promise<ChatTool[]>;
    agentId?: string;
    onError?: (err: Error) => void;
  }) {
    const listChatTools = vi.fn(opts.listChatTools);
    const speko = {
      agents: { tools: { listChatTools } },
    } as unknown as Speko;
    const loader = new RegisteredToolsLoader({
      speko,
      agentId: opts.agentId ?? 'agent_test',
      ...(opts.onError && { onError: opts.onError }),
    });
    return { loader, listChatTools };
  }

  it('calls listChatTools(agentId) and returns its result', async () => {
    const result: ChatTool[] = [
      {
        name: 'create_event',
        description: 'Create a calendar event',
        parameters: { type: 'object' },
        executionMode: 'integration',
        source: {
          kind: 'integration',
          installationId: '11111111-1111-4111-8111-111111111111',
          appKey: 'google_calendar',
          actionKey: 'create_event',
        },
      },
    ];
    const { loader, listChatTools } = makeLoader({
      listChatTools: async () => result,
      agentId: 'agent_42',
    });

    const tools = await loader.load();

    expect(listChatTools).toHaveBeenCalledTimes(1);
    expect(listChatTools.mock.calls[0]?.[0]).toBe('agent_42');
    expect(tools).toEqual(result);
  });

  it('forwards an AbortSignal to listChatTools (for the hard timeout)', async () => {
    const { loader, listChatTools } = makeLoader({ listChatTools: async () => [] });

    await loader.load();

    expect(listChatTools.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });

  it('caches: load() called three times triggers exactly one fetch', async () => {
    const { loader, listChatTools } = makeLoader({ listChatTools: async () => [] });

    await loader.load();
    await loader.load();
    await loader.load();

    expect(listChatTools).toHaveBeenCalledTimes(1);
  });

  it('parallel callers share the in-flight request (single fetch)', async () => {
    let resolveFetch: (r: ChatTool[]) => void = () => {};
    const { loader, listChatTools } = makeLoader({
      listChatTools: () =>
        new Promise<ChatTool[]>((resolve) => {
          resolveFetch = resolve;
        }),
    });

    const p1 = loader.load();
    const p2 = loader.load();
    expect(listChatTools).toHaveBeenCalledTimes(1);

    resolveFetch([]);

    await Promise.all([p1, p2]);
    expect(listChatTools).toHaveBeenCalledTimes(1);
  });

  it('returns undefined and reports the error when the fetch fails', async () => {
    const onError = vi.fn();
    const { loader } = makeLoader({
      listChatTools: async () => {
        throw new Error('connection refused');
      },
      onError,
    });

    const tools = await loader.load();
    expect(tools).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/connection refused/);
  });

  it('caches the error result too — failed load does not re-fetch every chat call', async () => {
    const onError = vi.fn();
    const { loader, listChatTools } = makeLoader({
      listChatTools: async () => {
        throw new Error('boom');
      },
      onError,
    });

    await loader.load();
    await loader.load();
    await loader.load();

    expect(listChatTools).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
