import { AudioFrame } from '@livekit/rtc-node';
import { describe, expect, it } from 'vitest';

import {
  createSampleRateNormalizer,
  framesToWav,
  parseWav,
  pcmSampleRateFromContentType,
} from './audio.js';

function makeFrame(samples: number[], sampleRate = 16000, channels = 1): AudioFrame {
  const int16 = new Int16Array(samples);
  return new AudioFrame(int16, sampleRate, channels, int16.length / channels);
}

describe('framesToWav', () => {
  it('produces a valid RIFF/WAVE header over the PCM payload', () => {
    const samples = [0, 1000, -1000, 2000, -2000, 0];
    const wav = framesToWav(makeFrame(samples, 16000));

    expect(wav.byteLength).toBe(44 + samples.length * 2);

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wav.slice(12, 16))).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(...wav.slice(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('merges an array of AudioFrames into one contiguous WAV', () => {
    const wav = framesToWav([makeFrame([1, 2, 3]), makeFrame([4, 5, 6])]);
    const { pcm, sampleRate, channels } = parseWav(wav);
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(Array.from(samples)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects multi-channel audio with a clear error', () => {
    expect(() => framesToWav(makeFrame([0, 0, 0, 0], 16000, 2))).toThrow(/mono audio/);
  });

  it('embeds the source frame sample rate, not a fixed value', () => {
    const wav = framesToWav(makeFrame([0, 0], 48000));
    const { sampleRate } = parseWav(wav);
    expect(sampleRate).toBe(48000);
  });
});

describe('parseWav', () => {
  it('throws on non-RIFF input', () => {
    expect(() => parseWav(new Uint8Array(100))).toThrow(/RIFF/);
  });

  it('throws on unsupported WAV format', () => {
    const wav = framesToWav(makeFrame([0, 0]));
    new DataView(wav.buffer, wav.byteOffset).setUint16(20, 3, true);
    expect(() => parseWav(wav)).toThrow(/unsupported WAV format/);
  });
});

describe('pcmSampleRateFromContentType', () => {
  it.each([
    ['audio/pcm;rate=24000', 16000, 24000],
    ['audio/pcm;rate=16000', 24000, 16000],
    ['audio/pcm', 22050, 22050],
    ['audio/pcm;rate=foo', 48000, 48000],
    ['audio/pcm;rate=44100;foo=bar', 16000, 44100],
  ])('parses %s with fallback %i → %i', (contentType, fallback, expected) => {
    expect(pcmSampleRateFromContentType(contentType, fallback)).toBe(expected);
  });
});

describe('createSampleRateNormalizer', () => {
  function silence(sampleRate: number, durationMs: number): AudioFrame {
    const samples = Math.round((sampleRate * durationMs) / 1000);
    return new AudioFrame(new Int16Array(samples), sampleRate, 1, samples);
  }

  it('is an identity pass-through when the rates already match', () => {
    const normalizer = createSampleRateNormalizer(24000, 24000, 1);
    const frame = silence(24000, 20);

    expect(normalizer.resampling).toBe(false);
    // Same instance: the common 24 kHz path must not copy or reframe audio.
    expect(normalizer.push(frame)).toEqual([frame]);
    expect(normalizer.flush()).toEqual([]);
    normalizer.close();
  });

  it('halves the sample count going 48 kHz -> 24 kHz and retags every frame', () => {
    const normalizer = createSampleRateNormalizer(48000, 24000, 1);
    expect(normalizer.resampling).toBe(true);

    const out: AudioFrame[] = [];
    for (let i = 0; i < 10; i += 1) out.push(...normalizer.push(silence(48000, 20)));
    out.push(...normalizer.flush());
    normalizer.close();

    expect(out.length).toBeGreaterThan(0);
    expect(out.every((frame) => frame.sampleRate === 24000)).toBe(true);
    // 200ms in at 48k = 9600 samples; 200ms out at 24k = 4800.
    expect(out.reduce((sum, frame) => sum + frame.samplesPerChannel, 0)).toBe(4800);
  });

  it('grows the sample count going 16 kHz -> 24 kHz', () => {
    const normalizer = createSampleRateNormalizer(16000, 24000, 1);
    const out: AudioFrame[] = [];
    for (let i = 0; i < 10; i += 1) out.push(...normalizer.push(silence(16000, 20)));
    out.push(...normalizer.flush());
    normalizer.close();

    expect(out.every((frame) => frame.sampleRate === 24000)).toBe(true);
    expect(out.reduce((sum, frame) => sum + frame.samplesPerChannel, 0)).toBe(4800);
  });

  it('close() is idempotent and stops producing frames', () => {
    // Called from a `finally`, so a double close must not throw on the native handle.
    const normalizer = createSampleRateNormalizer(48000, 24000, 1);
    normalizer.push(silence(48000, 20));
    normalizer.close();
    expect(() => normalizer.close()).not.toThrow();
    expect(normalizer.push(silence(48000, 20))).toEqual([]);
    expect(normalizer.flush()).toEqual([]);
  });
});
