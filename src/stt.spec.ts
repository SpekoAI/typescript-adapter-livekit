import { describe, expect, it, vi } from 'vitest';
import { AudioFrame } from '@livekit/rtc-node';
import { stt } from '@livekit/agents';
import type {
  Speko,
  TranscribeOptions,
  TranscribeResult,
} from '@speko/sdk';

import { SpekoSTT } from './stt.js';
import { parseWav } from './audio.js';

function makeFakeSpeko(result: TranscribeResult): {
  speko: Speko;
  transcribe: ReturnType<typeof vi.fn>;
} {
  const transcribe = vi.fn<
    (
      audio: Uint8Array,
      options: TranscribeOptions,
      abortSignal?: AbortSignal,
    ) => Promise<TranscribeResult>
  >(async () => result);
  return {
    speko: {
      transcribe,
      synthesize: vi.fn(),
      complete: vi.fn(),
      sessions: {} as unknown as Speko['sessions'],
      usage: {} as unknown as Speko['usage'],
    } as unknown as Speko,
    transcribe,
  };
}

function makeFrame(sampleRate = 16000): AudioFrame {
  const samples = new Int16Array([0, 1000, -1000, 2000, -2000, 0, 500, -500]);
  return new AudioFrame(samples, sampleRate, 1, samples.length);
}

describe('SpekoSTT', () => {
  it('forwards WAV bytes and intent to speko.transcribe', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'hello world',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 0.91,
      failoverCount: 0,
      scoresRunId: null,
    });

    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en-US', vertical: 'general', optimizeFor: 'accuracy' },
    });

    const event = await sttInstance.recognize(makeFrame());

    expect(transcribe).toHaveBeenCalledOnce();
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    const [audioArg, optionsArg] = call;
    expect(optionsArg).toMatchObject({
      language: 'en-US',
      vertical: 'general',
      optimizeFor: 'accuracy',
      contentType: 'audio/wav',
    });

    const { sampleRate, channels } = parseWav(audioArg);
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);

    expect(event.type).toBe(stt.SpeechEventType.FINAL_TRANSCRIPT);
    const [alt] = event.alternatives ?? [];
    expect(alt?.text).toBe('hello world');
    expect(alt?.confidence).toBe(0.91);
    expect(alt?.language).toBe('en-US');
  });

  it('defaults confidence to 1 when the proxy omits it', async () => {
    const { speko } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: null,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en', vertical: 'general' },
    });
    const event = await sttInstance.recognize(makeFrame());
    expect(event.alternatives?.[0]?.confidence).toBe(1);
  });

  it('forwards the abort signal into speko.transcribe', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en', vertical: 'general' },
    });
    const controller = new AbortController();
    await sttInstance.recognize(makeFrame(), controller.signal);
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    expect(call[2]).toBe(controller.signal);
  });

  it('omits optimizeFor from the options when the intent does not set it', async () => {
    const { speko, transcribe } = makeFakeSpeko({
      text: 'x',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en', vertical: 'general' },
    });
    await sttInstance.recognize(makeFrame());
    const call = transcribe.mock.calls[0];
    if (!call) throw new Error('expected transcribe to be called');
    expect(call[1]).not.toHaveProperty('optimizeFor');
  });

  it('throws a clear error when stream() is called directly', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    const sttInstance = new SpekoSTT({
      speko,
      intent: { language: 'en', vertical: 'general' },
    });
    expect(() => sttInstance.stream()).toThrow(/StreamAdapter/);
  });

  it('rejects an invalid intent at construction time', () => {
    const { speko } = makeFakeSpeko({
      text: '',
      provider: 'deepgram',
      model: 'nova-3',
      confidence: 1,
      failoverCount: 0,
      scoresRunId: null,
    });
    expect(
      () =>
        new SpekoSTT({
          speko,
          intent: {
            language: 'en',
            vertical: 'bogus' as unknown as 'general',
          },
        }),
    ).toThrow(/vertical/);
  });
});
