import { describe, expect, it } from 'vitest';
import { AudioFrame } from '@livekit/rtc-node';

import {
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
    const wav = framesToWav([
      makeFrame([1, 2, 3]),
      makeFrame([4, 5, 6]),
    ]);
    const { pcm, sampleRate, channels } = parseWav(wav);
    expect(sampleRate).toBe(16000);
    expect(channels).toBe(1);

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(Array.from(samples)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('rejects multi-channel audio with a clear error', () => {
    expect(() => framesToWav(makeFrame([0, 0, 0, 0], 16000, 2))).toThrow(
      /mono audio/,
    );
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
