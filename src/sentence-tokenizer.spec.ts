import type { tokenize } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { createDefaultSentenceTokenizer } from './sentence-tokenizer.js';

/**
 * Drain a sentence-tokenizer stream over `text` and return the emitted tokens —
 * mirrors how `tts.StreamAdapter` consumes the tokenizer (pushText → endInput →
 * iterate `ev.token`). The agent transcript is the concatenation of these tokens.
 */
async function streamTokens(
  tokenizer: tokenize.SentenceTokenizer,
  text: string,
): Promise<string[]> {
  const stream = tokenizer.stream();
  stream.pushText(text);
  stream.endInput(); // flushes the buffered remainder, then closes
  const tokens: string[] = [];
  for await (const ev of stream) tokens.push(ev.token);
  return tokens;
}

describe('createDefaultSentenceTokenizer (SPE-141)', () => {
  it('keeps inter-sentence spacing so concatenated tokens never glue sentences', async () => {
    const text = 'Отлично, система работает. Чем могу быть полезен? Например, записать на приём.';
    const tokens = await streamTokens(createDefaultSentenceTokenizer(), text);
    const joined = tokens.join('');

    // It actually split into multiple sentence chunks (otherwise the test is vacuous).
    expect(tokens.length).toBeGreaterThan(1);
    // The bug (SPE-141) was a sentence-ender immediately followed by a letter
    // ("работает.Чем"). Correctly-spaced text never has that.
    expect(joined).not.toMatch(/[.?!]\p{L}/u);
    // And the specific boundaries keep their space.
    expect(joined).toContain('работает. Чем');
    expect(joined).toContain('полезен? Например');
  });

  it('preserves spacing for English multi-sentence replies too', async () => {
    const text = 'Great, the system works. How can I help? For example, booking an appointment.';
    const joined = (await streamTokens(createDefaultSentenceTokenizer(), text)).join('');
    expect(joined).not.toMatch(/[.?!]\p{L}/u);
    expect(joined).toContain('works. How');
  });
});
