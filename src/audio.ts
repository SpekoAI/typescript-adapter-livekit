import type { AudioBuffer } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { AudioResampler, combineAudioFrames } from '@livekit/rtc-node';

import { SpekoAdapterError } from './errors.js';

const WAV_HEADER_BYTES = 44;
const PCM_FORMAT = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Encode a LiveKit `AudioBuffer` (single frame or array) into a standard
 * PCM16 WAV byte stream suitable for uploading to the Speko `/v1/transcribe`
 * endpoint (which defaults to `audio/wav`).
 *
 * v1 constraint: mono only. Multi-channel frames throw so that a confusing
 * downstream routing failure turns into a clear error at the adapter boundary.
 */
export function framesToWav(buffer: AudioBuffer): Uint8Array {
  const merged = combineAudioFrames(buffer);
  if (merged.channels !== 1) {
    throw new SpekoAdapterError(
      `SpekoSTT: expected mono audio (1 channel), got ${merged.channels}. ` +
        `Configure your LiveKit AgentSession to pass mono audio or pre-mix ` +
        `upstream of the STT.`,
      'UNSUPPORTED_CHANNELS',
    );
  }

  const pcm = merged.data;
  const dataByteLength = pcm.byteLength;
  const totalByteLength = WAV_HEADER_BYTES + dataByteLength;
  const out = new Uint8Array(totalByteLength);
  const view = new DataView(out.buffer);
  const byteRate = (merged.sampleRate * merged.channels * BITS_PER_SAMPLE) / 8;
  const blockAlign = (merged.channels * BITS_PER_SAMPLE) / 8;

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, totalByteLength - 8, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, merged.channels, true);
  view.setUint32(24, merged.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  out.set(pcmBytes, WAV_HEADER_BYTES);

  return out;
}

/**
 * Parse a PCM16 WAV byte stream, returning `{ pcm, sampleRate, channels }`.
 * Used by the TTS path to unwrap a WAV-formatted proxy response into raw
 * samples that can be fed into `AudioByteStream`.
 *
 * Only the minimal subset of the WAV spec we need: PCM format, 16-bit samples,
 * a `fmt ` chunk and a `data` chunk in that order. Non-conforming inputs throw a
 * coded {@link SpekoAdapterError} so the framework can tell a truncated payload
 * (`MALFORMED_AUDIO`, worth a retry that may fail over to another provider) from
 * a provider that is simply configured for the wrong format
 * (`UNSUPPORTED_AUDIO_FORMAT`, retrying it forever changes nothing).
 */
export function parseWav(bytes: Uint8Array): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    throw new SpekoAdapterError(
      `SpekoTTS: WAV response too small (${bytes.byteLength} bytes)`,
      'MALFORMED_AUDIO',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new SpekoAdapterError('SpekoTTS: not a RIFF/WAVE stream', 'MALFORMED_AUDIO');
  }
  if (readAscii(bytes, 12, 4) !== 'fmt ') {
    throw new SpekoAdapterError('SpekoTTS: missing `fmt ` chunk', 'MALFORMED_AUDIO');
  }
  const audioFormat = view.getUint16(20, true);
  if (audioFormat !== PCM_FORMAT) {
    throw new SpekoAdapterError(
      `SpekoTTS: unsupported WAV format ${audioFormat}, expected PCM (1)`,
      'UNSUPPORTED_AUDIO_FORMAT',
    );
  }
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (bitsPerSample !== BITS_PER_SAMPLE) {
    throw new SpekoAdapterError(
      `SpekoTTS: unsupported WAV bit depth ${bitsPerSample}, expected 16`,
      'UNSUPPORTED_AUDIO_FORMAT',
    );
  }

  const fmtChunkSize = view.getUint32(16, true);
  let cursor = 20 + fmtChunkSize;
  while (cursor + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, cursor, 4);
    const chunkSize = view.getUint32(cursor + 4, true);
    const chunkStart = cursor + 8;
    if (chunkId === 'data') {
      const pcm = bytes.subarray(chunkStart, chunkStart + chunkSize);
      return { pcm, sampleRate, channels };
    }
    cursor = chunkStart + chunkSize;
  }
  throw new SpekoAdapterError('SpekoTTS: WAV stream missing `data` chunk', 'MALFORMED_AUDIO');
}

/**
 * Parse the `rate` parameter from an `audio/pcm;rate=NNNN` content type, which
 * is what the Speko gateway reports on both `Content-Type` and
 * `X-Speko-Audio-Format`. Falls back to the supplied default when the rate is
 * missing or unparseable.
 */
export function pcmSampleRateFromContentType(contentType: string, fallback: number): number {
  const match = contentType.match(/rate=(\d+)/i);
  if (!match || match[1] === undefined) return fallback;
  const rate = parseInt(match[1], 10);
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

/**
 * Converts frames from whatever rate the routed provider actually produced to
 * the single rate this TTS instance advertises to LiveKit. A pass-through (and
 * allocation-free) when the rates already agree, which is the common 24 kHz case.
 *
 * See `SpekoTTS` in `tts.ts` for why the adapter normalizes rather than emitting
 * the provider's rate straight through.
 */
export interface SampleRateNormalizer {
  /** True when a real resampler is engaged (rates differ). */
  readonly resampling: boolean;
  push(frame: AudioFrame): AudioFrame[];
  /** Drains the resampler's warm-up tail. Must run before {@link close}. */
  flush(): AudioFrame[];
  /** Releases the native resampler handle. Idempotent; safe in a `finally`. */
  close(): void;
}

export function createSampleRateNormalizer(
  inputRate: number,
  outputRate: number,
  channels = 1,
): SampleRateNormalizer {
  if (inputRate === outputRate) {
    return {
      resampling: false,
      push: (frame) => [frame],
      flush: () => [],
      close: () => {},
    };
  }

  // AudioResampler wraps a native soxr handle, so it must be closed exactly
  // once; leaking one per utterance would leak an FD per turn.
  const resampler = new AudioResampler(inputRate, outputRate, channels);
  let closed = false;
  return {
    resampling: true,
    push: (frame) => (closed ? [] : resampler.push(frame)),
    flush: () => (closed ? [] : resampler.flush()),
    close: () => {
      if (closed) return;
      closed = true;
      resampler.close();
    },
  };
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buf[offset + i] = text.charCodeAt(i);
  }
}

function readAscii(buf: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(buf[offset + i] ?? 0);
  }
  return out;
}
