import {
  AudioByteStream,
  tts,
  type APIConnectOptions,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { Speko, SynthesizeResult } from '@speko/sdk';

import { parseWav, pcmSampleRateFromContentType } from './audio.js';
import { type Intent, validateIntent } from './intent.js';

/**
 * Default output sample rate advertised to the LiveKit `AgentSession`. Speko's
 * Cartesia path returns 24 kHz raw PCM; the ElevenLabs path returns MP3 which
 * v1 does not decode — callers who need MP3 support should either configure
 * Speko to avoid ElevenLabs or wait for v2.
 */
const DEFAULT_SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;

export interface SpekoTTSOptions {
  speko: Speko;
  intent: Intent;
  /** Voice id override forwarded to the Speko proxy. */
  voice?: string;
  /** Forwarded speech speed override. */
  speed?: number;
  /**
   * Output sample rate advertised to the LiveKit agent. Must match what the
   * upstream provider actually emits, otherwise playback will be pitched.
   * Defaults to 24000 (Cartesia Sonic default).
   */
  sampleRate?: number;
}

/**
 * LiveKit Agents TTS adapter that delegates synthesis to the Speko proxy
 * (`POST /v1/synthesize`). The router picks the best TTS provider per intent
 * and fails over automatically.
 *
 * v1 is non-streaming (buffered turn-by-turn). Wrap with
 * `tts.StreamAdapter` + a sentence tokenizer to plug into a
 * `voice.AgentSession`, or use `createSpekoComponents()` which does that for
 * you.
 *
 * **Audio format constraint**: the adapter accepts either `audio/pcm;rate=NNNN`
 * (e.g. Cartesia) or `audio/wav`. `audio/mpeg` (ElevenLabs MP3) throws a clear
 * error in v1 — add an MP3 decoder or configure Speko to avoid ElevenLabs to
 * work around it.
 */
export class SpekoTTS extends tts.TTS {
  label = 'speko.TTS';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #sampleRate: number;

  constructor(options: SpekoTTSOptions) {
    validateIntent(options.intent);
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    super(sampleRate, NUM_CHANNELS, { streaming: false });
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#voice = options.voice;
    this.#speed = options.speed;
    this.#sampleRate = sampleRate;
  }

  override get provider(): string {
    return 'speko';
  }

  override get model(): string {
    return 'speko-router';
  }

  override synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ): tts.ChunkedStream {
    return new SpekoTTSChunkedStream({
      text,
      tts: this,
      speko: this.#speko,
      intent: this.#intent,
      voice: this.#voice,
      speed: this.#speed,
      expectedSampleRate: this.#sampleRate,
      connOptions,
      abortSignal,
    });
  }

  override stream(_options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    throw new Error(
      'SpekoTTS does not support native streaming (Speko proxy is buffered). ' +
        'Wrap this instance with `new tts.StreamAdapter(spekoTts, sentenceTokenizer)` ' +
        'from @livekit/agents, or pass it through `createSpekoComponents()` which ' +
        'returns a ready-to-use StreamAdapter-wrapped TTS.',
    );
  }
}

interface SpekoTTSChunkedStreamArgs {
  text: string;
  tts: SpekoTTS;
  speko: Speko;
  intent: Intent;
  voice?: string;
  speed?: number;
  expectedSampleRate: number;
  connOptions?: APIConnectOptions;
  abortSignal?: AbortSignal;
}

export class SpekoTTSChunkedStream extends tts.ChunkedStream {
  label = 'speko.TTSChunkedStream';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #expectedSampleRate: number;

  constructor(args: SpekoTTSChunkedStreamArgs) {
    super(args.text, args.tts, args.connOptions, args.abortSignal);
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#voice = args.voice;
    this.#speed = args.speed;
    this.#expectedSampleRate = args.expectedSampleRate;
  }

  protected async run(): Promise<void> {
    const result = await this.#speko.synthesize(
      this.inputText,
      {
        language: this.#intent.language,
        vertical: this.#intent.vertical,
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
        ...(this.#voice !== undefined && { voice: this.#voice }),
        ...(this.#speed !== undefined && { speed: this.#speed }),
      },
      this.abortSignal,
    );

    const { pcm, sampleRate, channels } = decodeSynthesisResult(result);

    if (sampleRate !== this.#expectedSampleRate) {
      throw new Error(
        `SpekoTTS: provider returned audio at ${sampleRate} Hz but the TTS was ` +
          `configured for ${this.#expectedSampleRate} Hz. Either set ` +
          `\`sampleRate: ${sampleRate}\` on SpekoTTS or pin the Speko router to a ` +
          `provider that matches the expected rate.`,
      );
    }

    const requestId = crypto.randomUUID();
    const samplesPerFrame = Math.round(sampleRate / 50);
    const bstream = new AudioByteStream(sampleRate, channels, samplesPerFrame);
    const frames = [...bstream.write(pcm), ...bstream.flush()];

    if (frames.length === 0) {
      throw new Error('SpekoTTS: provider returned empty audio');
    }

    this.#pushFrames(frames, requestId);
  }

  #pushFrames(frames: AudioFrame[], requestId: string): void {
    let pending: AudioFrame | undefined;
    const flush = (final: boolean) => {
      if (!pending) return;
      this.queue.put({
        requestId,
        segmentId: requestId,
        frame: pending,
        final,
      });
      pending = undefined;
    };

    for (const frame of frames) {
      flush(false);
      pending = frame;
    }
    flush(true);
  }
}

/**
 * Decode a `SynthesizeResult` into raw PCM + sample rate + channel count.
 * Branches on `contentType`:
 *
 * - `audio/pcm;rate=NNNN` → raw payload, rate parsed from MIME parameters.
 *   Cartesia's contract is mono, so channels is pinned to {@link NUM_CHANNELS}.
 * - `audio/wav` / `audio/x-wav` → WAV header stripped via `parseWav`. The
 *   embedded channel count is validated — v1 only handles mono, and a stereo
 *   response would otherwise be fed to a mono `AudioByteStream` and played at
 *   half speed with L/R mixed.
 * - `audio/mpeg` or anything else → throws, documented v1 limitation.
 *
 * Exported for unit testing.
 */
export function decodeSynthesisResult(result: SynthesizeResult): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  const contentType = result.contentType.toLowerCase();

  if (contentType.startsWith('audio/pcm')) {
    return {
      pcm: result.audio,
      sampleRate: pcmSampleRateFromContentType(contentType, DEFAULT_SAMPLE_RATE),
      channels: NUM_CHANNELS,
    };
  }

  if (contentType.startsWith('audio/wav') || contentType.startsWith('audio/x-wav')) {
    const { pcm, sampleRate, channels } = parseWav(result.audio);
    if (channels !== NUM_CHANNELS) {
      throw new Error(
        `SpekoTTS: WAV response has ${channels} channels but the adapter is ` +
          `configured for ${NUM_CHANNELS}. Configure the Speko router to return ` +
          `mono audio, or pin a mono-only provider.`,
      );
    }
    return { pcm, sampleRate, channels };
  }

  if (contentType.startsWith('audio/mpeg')) {
    throw new Error(
      `SpekoTTS: received ${result.contentType} from provider "${result.provider}". ` +
        'v1 only supports raw PCM (`audio/pcm;rate=NNNN`) and WAV (`audio/wav`). ' +
        'Configure your Speko routing intent so Cartesia is preferred, or pin the ' +
        'TTS provider explicitly.',
    );
  }

  throw new Error(
    `SpekoTTS: unsupported content type "${result.contentType}" from provider ` +
      `"${result.provider}". Expected audio/pcm, audio/wav, or (in future) audio/mpeg.`,
  );
}
