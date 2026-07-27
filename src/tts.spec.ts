import { initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import type { Speko, SynthesizeResult, SynthesizeStreamResult } from '@spekoai/sdk';
import { describe, expect, it } from 'vitest';
import { framesToWav } from './audio.js';
import { decodeSynthesisResult, SpekoTTS } from './tts.js';

initializeLogger({ pretty: false, level: 'silent' });

function makeResult(
  overrides: Partial<SynthesizeResult> & Pick<SynthesizeResult, 'audio' | 'contentType'>,
): SynthesizeResult {
  return {
    provider: 'cartesia',
    model: 'sonic-3',
    failoverCount: 0,
    scoresRunId: null,
    ...overrides,
  };
}

/** Silent 16-bit mono PCM of the requested duration at the requested rate. */
function silentPcm(sampleRate: number, durationMs: number): Uint8Array {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  return new Uint8Array(samples * 2);
}

/**
 * A `Speko` whose `synthesizeStream` replays one canned response. `audioFormat`
 * stands in for the `X-Speko-Audio-Format` header a newer SDK would surface.
 */
function fakeSpeko(response: {
  contentType: string;
  audio: Uint8Array;
  audioFormat?: string;
  provider?: string;
  chunkBytes?: number;
}): Speko {
  const { audio, chunkBytes = 4096 } = response;
  const streamed = {
    contentType: response.contentType,
    ...(response.audioFormat !== undefined && { audioFormat: response.audioFormat }),
    provider: response.provider ?? 'cartesia',
    model: 'sonic-3',
    failoverCount: 0,
    scoresRunId: null,
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < audio.byteLength; offset += chunkBytes) {
        yield audio.subarray(offset, Math.min(offset + chunkBytes, audio.byteLength));
      }
    },
  } as unknown as SynthesizeStreamResult;

  return {
    synthesizeStream: async () => streamed,
  } as unknown as Speko;
}

async function synthesizeFrames(speko: Speko, sampleRate?: number): Promise<AudioFrame[]> {
  const tts = new SpekoTTS({
    speko,
    intent: { language: 'en' },
    ...(sampleRate !== undefined && { sampleRate }),
  });
  const frames: AudioFrame[] = [];
  for await (const audio of tts.synthesize('hello there')) frames.push(audio.frame);
  return frames;
}

function totalSamples(frames: readonly AudioFrame[]): number {
  return frames.reduce((sum, frame) => sum + frame.samplesPerChannel, 0);
}

function distinctRates(frames: readonly AudioFrame[]): number[] {
  return [...new Set(frames.map((frame) => frame.sampleRate))];
}

describe('decodeSynthesisResult', () => {
  it('passes through raw PCM and reads the sample rate from the MIME type', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const {
      pcm: out,
      sampleRate,
      channels,
    } = decodeSynthesisResult(makeResult({ audio: pcm, contentType: 'audio/pcm;rate=24000' }));
    expect(out).toBe(pcm);
    expect(sampleRate).toBe(24000);
    expect(channels).toBe(1);
  });

  it('decodes a WAV payload and surfaces the embedded sample rate + channels', () => {
    const frame = new AudioFrame(new Int16Array([10, 20, 30, 40]), 16000, 1, 4);
    const wav = framesToWav(frame);
    const { pcm, sampleRate, channels } = decodeSynthesisResult(
      makeResult({ audio: wav, contentType: 'audio/wav' }),
    );
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(Array.from(samples)).toEqual([10, 20, 30, 40]);
  });

  it('rejects a multi-channel WAV response with a clear error', () => {
    const frame = new AudioFrame(new Int16Array([10, 20, 30, 40]), 16000, 1, 4);
    const wav = framesToWav(frame);
    new DataView(wav.buffer, wav.byteOffset).setUint16(22, 2, true);
    expect(() =>
      decodeSynthesisResult(
        makeResult({ audio: wav, contentType: 'audio/wav', provider: 'weird' }),
      ),
    ).toThrow(/channels/);
  });

  it('throws a clear error for MP3 audio in v1', () => {
    expect(() =>
      decodeSynthesisResult(
        makeResult({
          audio: new Uint8Array([0xff, 0xfb, 0x00]),
          contentType: 'audio/mpeg',
          provider: 'elevenlabs',
        }),
      ),
    ).toThrow(/v1 only supports/);
  });

  it('throws for unknown content types', () => {
    expect(() =>
      decodeSynthesisResult(
        makeResult({
          audio: new Uint8Array([0]),
          contentType: 'application/octet-stream',
          provider: 'weird',
        }),
      ),
    ).toThrow(/unsupported content type/);
  });

  it('branches on an explicit audioFormat override rather than contentType', () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const { sampleRate } = decodeSynthesisResult(
      // A CDN rewrote Content-Type; X-Speko-Audio-Format still tells the truth.
      makeResult({ audio: pcm, contentType: 'application/octet-stream' }),
      'audio/pcm;rate=48000',
    );
    expect(sampleRate).toBe(48000);
  });
});

// The gateway's CONTENT_TYPE map (apps/server/src/routes/synthesize.ts) serves
// 48 kHz for Hume and Gradium and 16 kHz for Amazon Polly, and a failover can
// land on one of them without the caller asking. Each of these used to abort the
// utterance with a non-retryable sample-rate-mismatch error.
describe('SpekoTTS sample-rate handling', () => {
  it('resamples a 48 kHz streaming PCM response to the declared 24 kHz', async () => {
    const frames = await synthesizeFrames(
      fakeSpeko({
        contentType: 'audio/pcm;rate=48000',
        audio: silentPcm(48_000, 200),
        provider: 'hume',
      }),
    );

    expect(frames.length).toBeGreaterThan(0);
    expect(distinctRates(frames)).toEqual([24_000]);
    // Same wall-clock audio, half the samples.
    expect(totalSamples(frames) / 24_000).toBeCloseTo(0.2, 1);
  });

  it('resamples a 16 kHz streaming PCM response (Polly) up to the declared 24 kHz', async () => {
    const frames = await synthesizeFrames(
      fakeSpeko({
        contentType: 'audio/pcm;rate=16000',
        audio: silentPcm(16_000, 200),
        provider: 'polly',
      }),
    );

    expect(frames.length).toBeGreaterThan(0);
    expect(distinctRates(frames)).toEqual([24_000]);
    expect(totalSamples(frames) / 24_000).toBeCloseTo(0.2, 1);
  });

  it('passes a matching 24 kHz response through untouched (no resampling)', async () => {
    const frames = await synthesizeFrames(
      fakeSpeko({ contentType: 'audio/pcm;rate=24000', audio: silentPcm(24_000, 200) }),
    );

    expect(distinctRates(frames)).toEqual([24_000]);
    // Byte-exact: an identity normalizer must not lose or invent a sample.
    expect(totalSamples(frames)).toBe(4800);
  });

  it('honours a caller-declared sampleRate, resampling a 24 kHz response to it', async () => {
    const frames = await synthesizeFrames(
      fakeSpeko({ contentType: 'audio/pcm;rate=24000', audio: silentPcm(24_000, 200) }),
      48_000,
    );

    expect(distinctRates(frames)).toEqual([48_000]);
    expect(totalSamples(frames) / 48_000).toBeCloseTo(0.2, 1);
  });

  it('resamples a 16 kHz WAV response on the batch path', async () => {
    const samples = new Int16Array(16_000 / 5); // 200ms
    const wav = framesToWav(new AudioFrame(samples, 16_000, 1, samples.length));
    const frames = await synthesizeFrames(
      fakeSpeko({ contentType: 'audio/wav', audio: wav, provider: 'polly' }),
    );

    expect(frames.length).toBeGreaterThan(0);
    expect(distinctRates(frames)).toEqual([24_000]);
    expect(totalSamples(frames) / 24_000).toBeCloseTo(0.2, 1);
  });

  it('reads the rate from X-Speko-Audio-Format when Content-Type has been rewritten', async () => {
    const frames = await synthesizeFrames(
      fakeSpeko({
        // An intermediary replaced Content-Type; without reading the Speko header
        // this response decodes as an unsupported content type and the turn dies.
        contentType: 'application/octet-stream',
        audioFormat: 'audio/pcm;rate=48000',
        audio: silentPcm(48_000, 200),
        provider: 'gradium',
      }),
    );

    expect(distinctRates(frames)).toEqual([24_000]);
    expect(totalSamples(frames) / 24_000).toBeCloseTo(0.2, 1);
  });
});
