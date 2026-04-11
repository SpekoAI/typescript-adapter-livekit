import { describe, expect, it } from 'vitest';
import { llm } from '@livekit/agents';

import { chatContextToSpeko } from './llm.js';

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

    const { messages, systemPrompt } = chatContextToSpeko(ctx);

    expect(systemPrompt).toBeUndefined();
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you' },
    ]);
  });

  it('lifts system messages into systemPrompt and drops them from messages', () => {
    const ctx = makeCtx([
      { role: 'system', content: 'You are a bot.' },
      { role: 'user', content: 'hi' },
    ]);

    const { messages, systemPrompt } = chatContextToSpeko(ctx);

    expect(systemPrompt).toBe('You are a bot.');
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('merges multiple system messages with double newlines', () => {
    const ctx = makeCtx([
      { role: 'system', content: 'Rule 1.' },
      { role: 'system', content: 'Rule 2.' },
      { role: 'user', content: 'hi' },
    ]);

    const { systemPrompt } = chatContextToSpeko(ctx);
    expect(systemPrompt).toBe('Rule 1.\n\nRule 2.');
  });

  it('treats developer-role messages as system prompts', () => {
    const ctx = makeCtx([
      { role: 'developer', content: 'Be terse.' },
      { role: 'user', content: 'hi' },
    ]);

    const { systemPrompt } = chatContextToSpeko(ctx);
    expect(systemPrompt).toBe('Be terse.');
  });

  it('skips messages whose textContent is empty', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'user', content: [] });
    ctx.addMessage({ role: 'user', content: 'real message' });

    const { messages } = chatContextToSpeko(ctx);
    expect(messages).toEqual([{ role: 'user', content: 'real message' }]);
  });
});
