import { describe, expect, it } from 'vitest';
import type { SynthesizeResult } from '@spekoai/sdk';

import { framesToWav } from './audio.js';
import { decodeSynthesisResult } from './tts.js';
import { AudioFrame } from '@livekit/rtc-node';

function makeResult(overrides: Partial<SynthesizeResult> & Pick<SynthesizeResult, 'audio' | 'contentType'>): SynthesizeResult {
  return {
    provider: 'cartesia',
    model: 'sonic-3',
    failoverCount: 0,
    scoresRunId: null,
    ...overrides,
  };
}

describe('decodeSynthesisResult', () => {
  it('passes through raw PCM and reads the sample rate from the MIME type', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const { pcm: out, sampleRate, channels } = decodeSynthesisResult(
      makeResult({ audio: pcm, contentType: 'audio/pcm;rate=24000' }),
    );
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
});
