import { initializeLogger, llm } from '@livekit/agents';
import type { CompleteParams, CompleteStreamEvent, Speko } from '@spekoai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { chatContextToSpeko, SpekoLLM, type SpekoLLMGenerationInfo } from './llm.js';

initializeLogger({ pretty: false, level: 'silent' });

function makeCtx(messages: { role: llm.ChatRole; content: string }[]): llm.ChatContext {
  const ctx = llm.ChatContext.empty();
  for (const m of messages) ctx.addMessage({ role: m.role, content: m.content });
  return ctx;
}

describe('chatContextToSpeko', () => {
  it('maps user and assistant messages in order', () => {
    const ctx = makeCtx([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]);

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]);
  });

  it('emits system messages inline, preserving order', () => {
    const ctx = makeCtx([
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'hi' },
    ]);

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('emits each system message as its own inline turn', () => {
    const ctx = makeCtx([
      { role: 'system', content: 'Rule 1.' },
      { role: 'system', content: 'Rule 2.' },
      { role: 'user', content: 'hi' },
    ]);

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'system', content: 'Rule 1.' },
      { role: 'system', content: 'Rule 2.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it("maps developer-role messages to role:'system' inline", () => {
    const ctx = makeCtx([
      { role: 'developer', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('skips messages whose textContent is empty', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: [] });
    ctx.addMessage({ role: 'user', content: 'real message' });

    const messages = chatContextToSpeko(ctx);
    expect(messages).toEqual([{ role: 'user', content: 'real message' }]);
  });

  it('emits a system-only greeting context as two inline system turns', () => {
    const ctx = makeCtx([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'Greet the user warmly.' },
    ]);

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'system', content: 'Greet the user warmly.' },
    ]);
  });

  it('returns an empty array when every item is skippable', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: [] });

    expect(chatContextToSpeko(ctx)).toEqual([]);
  });

  it('round-trips a FunctionCall as an assistant message with toolCalls', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: 'book me 3pm tuesday' });
    ctx.insert(
      llm.FunctionCall.create({
        callId: 'call_42',
        name: 'book_appointment',
        args: '{"date":"2026-05-05","time":"15:00"}',
      }),
    );

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'user', content: 'book me 3pm tuesday' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_42',
            name: 'book_appointment',
            args: '{"date":"2026-05-05","time":"15:00"}',
          },
        ],
      },
    ]);
  });

  it("round-trips a FunctionCallOutput as a role:'tool' message", () => {
    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCall.create({
        callId: 'call_42',
        name: 'book_appointment',
        args: '{}',
      }),
    );
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_42',
        output: '{"confirmed":true,"id":"ABC"}',
        isError: false,
      }),
    );

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_42', name: 'book_appointment', args: '{}' }],
      },
      {
        role: 'tool',
        content: '{"confirmed":true,"id":"ABC"}',
        toolCallId: 'call_42',
      },
    ]);
  });

  it("propagates FunctionCallOutput.isError as message-level isError on role:'tool'", () => {
    const ctx = llm.ChatContext.empty();
    ctx.insert(
      llm.FunctionCall.create({
        callId: 'call_99',
        name: 'risky_tool',
        args: '{}',
      }),
    );
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'call_99',
        output: 'connection refused',
        isError: true,
      }),
    );

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_99', name: 'risky_tool', args: '{}' }],
      },
      {
        role: 'tool',
        content: 'connection refused',
        toolCallId: 'call_99',
        isError: true,
      },
    ]);
  });

  it('preserves order across mixed message and function-call items', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'system', content: 'You are a booking agent.' });
    ctx.addMessage({ role: 'user', content: 'check tuesday' });
    ctx.insert(
      llm.FunctionCall.create({
        callId: 'c1',
        name: 'check_availability',
        args: '{"day":"tuesday"}',
      }),
    );
    ctx.insert(
      llm.FunctionCallOutput.create({
        callId: 'c1',
        output: '["3pm","4pm"]',
        isError: false,
      }),
    );
    ctx.addMessage({ role: 'assistant', content: '3pm or 4pm work?' });

    const messages = chatContextToSpeko(ctx);

    expect(messages).toEqual([
      { role: 'system', content: 'You are a booking agent.' },
      { role: 'user', content: 'check tuesday' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'check_availability', args: '{"day":"tuesday"}' }],
      },
      { role: 'tool', content: '["3pm","4pm"]', toolCallId: 'c1' },
      { role: 'assistant', content: '3pm or 4pm work?' },
    ]);
  });
});

describe('SpekoLLM', () => {
  it('marks complete requests as voice-optimized', async () => {
    let captured: (CompleteParams & { voiceOptimized?: boolean }) | undefined;
    const speko = {
      async *completeStream(params: CompleteParams): AsyncIterableIterator<CompleteStreamEvent> {
        captured = params as CompleteParams & { voiceOptimized?: boolean };
        yield { type: 'delta', text: 'ok' };
        yield {
          type: 'done',
          text: 'ok',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          usage: { promptTokens: 1, completionTokens: 1 },
          failoverCount: 0,
          scoresRunId: null,
        };
      },
    } as unknown as Speko;
    const model = new SpekoLLM({
      speko,
      intent: { language: 'en', optimizeFor: 'latency' },
    });

    const response = await model
      .chat({ chatCtx: makeCtx([{ role: 'user', content: 'hi' }]) })
      .collect();

    expect(response.text).toBe('ok');
    expect(captured).toMatchObject({
      voiceOptimized: true,
      intent: { language: 'en', optimizeFor: 'latency' },
    });
  });

  it('invokes onGenerationAborted with increasing epochs for aborted runs', async () => {
    const aborted: SpekoLLMGenerationInfo[] = [];
    const speko = {
      async *completeStream(
        _params: CompleteParams,
        abortSignal?: AbortSignal,
      ): AsyncIterableIterator<CompleteStreamEvent> {
        await new Promise<never>((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          abortSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
      },
    } as unknown as Speko;
    const model = new SpekoLLM({
      speko,
      intent: { language: 'en' },
      onGenerationAborted: (info) => aborted.push(info),
    });

    for (let i = 0; i < 2; i += 1) {
      const stream = model.chat({ chatCtx: makeCtx([{ role: 'user', content: `hi ${i}` }]) });
      stream.close();
      await stream.collect();
      await vi.waitFor(() => expect(aborted).toHaveLength(i + 1));
    }

    expect(aborted.map((info) => info.epoch)).toEqual([1, 2]);
    expect(aborted.every((info) => Number.isFinite(info.at))).toBe(true);
  });

  it('does not invoke onGenerationAborted for completed runs', async () => {
    const aborted: SpekoLLMGenerationInfo[] = [];
    const speko = {
      async *completeStream(): AsyncIterableIterator<CompleteStreamEvent> {
        yield { type: 'delta', text: 'ok' };
        yield {
          type: 'done',
          text: 'ok',
          provider: 'openai',
          model: 'gpt-4.1-mini',
          usage: { promptTokens: 1, completionTokens: 1 },
          failoverCount: 0,
          scoresRunId: null,
        };
      },
    } as unknown as Speko;
    const model = new SpekoLLM({
      speko,
      intent: { language: 'en' },
      onGenerationAborted: (info) => aborted.push(info),
    });

    const response = await model
      .chat({ chatCtx: makeCtx([{ role: 'user', content: 'hi' }]) })
      .collect();

    expect(response.text).toBe('ok');
    expect(aborted).toEqual([]);
  });
});
