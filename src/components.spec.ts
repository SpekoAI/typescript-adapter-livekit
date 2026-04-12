import { describe, expect, it, vi } from 'vitest';
import { stt, tts } from '@livekit/agents';
import type { Speko } from '@spekoai/sdk';

import { createSpekoComponents } from './components.js';
import { SpekoLLM } from './llm.js';

function makeFakeSpeko(): Speko {
  return {
    transcribe: vi.fn(),
    synthesize: vi.fn(),
    complete: vi.fn(),
    sessions: {} as unknown as Speko['sessions'],
    usage: {} as unknown as Speko['usage'],
  } as unknown as Speko;
}

function makeFakeVAD() {
  return {
    stream: () => ({}),
    on: vi.fn(),
    emit: vi.fn(),
  } as unknown as Parameters<typeof createSpekoComponents>[0]['vad'];
}

describe('createSpekoComponents', () => {
  it('returns StreamAdapter-wrapped STT and TTS plus a raw LLM', () => {
    const components = createSpekoComponents({
      speko: makeFakeSpeko(),
      intent: { language: 'en', vertical: 'general' },
      vad: makeFakeVAD(),
    });

    expect(components.stt).toBeInstanceOf(stt.StreamAdapter);
    expect(components.stt.capabilities.streaming).toBe(true);
    expect(components.llm).toBeInstanceOf(SpekoLLM);
    expect(components.tts).toBeInstanceOf(tts.StreamAdapter);
  });

  it('propagates the intent to the adapter pipeline', () => {
    const components = createSpekoComponents({
      speko: makeFakeSpeko(),
      intent: {
        language: 'es-MX',
        vertical: 'healthcare',
        optimizeFor: 'accuracy',
      },
      vad: makeFakeVAD(),
    });

    expect(components.llm.label()).toBe('speko.LLM');
    expect(components.llm.provider).toBe('speko');
  });

  it('validates the intent eagerly and throws when it is bad', () => {
    expect(() =>
      createSpekoComponents({
        speko: makeFakeSpeko(),
        intent: {
          language: 'en',
          vertical: 'unknown' as unknown as 'general',
        },
        vad: makeFakeVAD(),
      }),
    ).toThrow(/vertical/);
  });
});
