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
});
