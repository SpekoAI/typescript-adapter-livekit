import { stt, tts } from '@livekit/agents';
import type { Speko } from '@spekoai/sdk';
import { describe, expect, it, vi } from 'vitest';

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
  it('returns StreamAdapter-wrapped STT and TTS plus a raw LLM in batch mode', () => {
    const components = createSpekoComponents({
      speko: makeFakeSpeko(),
      intent: { language: 'en' },
      vad: makeFakeVAD(),
      sttStreaming: false,
    });

    expect(components.stt).toBeInstanceOf(stt.StreamAdapter);
    expect(components.stt.capabilities.streaming).toBe(true);
    expect(components.llm).toBeInstanceOf(SpekoLLM);
    expect(components.tts).toBeInstanceOf(tts.StreamAdapter);
  });

  it('returns a streaming SpekoSTT by default (no StreamAdapter wrap)', () => {
    const components = createSpekoComponents({
      speko: makeFakeSpeko(),
      intent: { language: 'en' },
      vad: makeFakeVAD(),
      sttBaseUrl: 'https://api.speko.dev',
      sttApiKey: 'sk-test',
    });

    expect(components.stt).not.toBeInstanceOf(stt.StreamAdapter);
    expect(components.stt.capabilities.streaming).toBe(true);
    expect(components.tts).toBeInstanceOf(tts.StreamAdapter);
  });

  it('throws when streaming is on without sttBaseUrl/sttApiKey', () => {
    expect(() =>
      createSpekoComponents({
        speko: makeFakeSpeko(),
        intent: { language: 'en' },
        vad: makeFakeVAD(),
      }),
    ).toThrow(/sttBaseUrl|sttApiKey/);
  });

  it('propagates the intent to the adapter pipeline', () => {
    const components = createSpekoComponents({
      speko: makeFakeSpeko(),
      intent: {
        language: 'es-MX',
        optimizeFor: 'accuracy',
      },
      vad: makeFakeVAD(),
      sttStreaming: false,
    });

    expect(components.llm.label()).toBe('speko.LLM');
    expect(components.llm.provider).toBe('speko');
  });

  it('validates the intent eagerly and throws when it is bad', () => {
    expect(() =>
      createSpekoComponents({
        speko: makeFakeSpeko(),
        intent: {
          language: '' as unknown as string,
        },
        vad: makeFakeVAD(),
        sttStreaming: false,
      }),
    ).toThrow(/language/);
  });

  // Word-alignment gate: this is the precondition for LiveKit's adaptive
  // interruption detector. Dashboard-stored pins are MODEL-QUALIFIED
  // ("deepgram:nova-3"); a provider-only comparison silently disabled adaptive
  // for every such agent (the barge-in "conversation collapse" root cause).
  describe('alignedTranscript gate', () => {
    function makeStreaming(sttPins: string[] | undefined) {
      return createSpekoComponents({
        speko: makeFakeSpeko(),
        intent: { language: 'en' },
        vad: makeFakeVAD(),
        sttBaseUrl: 'https://api.speko.dev',
        sttApiKey: 'sk-test',
        ...(sttPins ? { constraints: { allowedProviders: { stt: sttPins } } } : {}),
      });
    }

    it.each([
      ['deepgram'],
      ['deepgram:nova-3'],
      ['DeepGram:NOVA-3'],
      ['elevenlabs:scribe-rt'],
      ['cartesia:ink-whisper'],
    ])('declares word alignment for the single word-emitting pin %j (bare or model-qualified)', (pin) => {
      expect(makeStreaming([pin]).stt.capabilities.alignedTranscript).toBe('word');
    });

    it.each([
      [['deepgram:nova-3', 'elevenlabs:scribe-rt']], // multiple pins → provider not guaranteed
      [['google']], // pinned, but not a word-emitting provider
      [[]],
      [undefined],
    ])('does NOT declare word alignment for pins %j', (pins) => {
      expect(makeStreaming(pins as string[] | undefined).stt.capabilities.alignedTranscript).toBe(
        false,
      );
    });

    it('never declares word alignment in batch mode, even with a deepgram pin', () => {
      const components = createSpekoComponents({
        speko: makeFakeSpeko(),
        intent: { language: 'en' },
        vad: makeFakeVAD(),
        sttStreaming: false,
        constraints: { allowedProviders: { stt: ['deepgram:nova-3'] } },
      });
      expect(components.stt.capabilities.alignedTranscript).not.toBe('word');
    });
  });
});
