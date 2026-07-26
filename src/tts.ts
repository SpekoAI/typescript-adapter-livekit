import { type APIConnectOptions, APIError, AudioByteStream, log, tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type {
  PipelineConstraints,
  Speko,
  SynthesizeResult,
  SynthesizeStreamResult,
} from '@spekoai/sdk';

import { createSampleRateNormalizer, parseWav, pcmSampleRateFromContentType } from './audio.js';
import { isAbortError, SpekoAdapterError, toFrameworkApiError } from './errors.js';
import { type Intent, validateIntent } from './intent.js';

/**
 * Default output sample rate advertised to the LiveKit `AgentSession`. Most
 * routed providers emit 24 kHz mono PCM, but not all: the gateway's
 * `CONTENT_TYPE` map (apps/server/src/routes/synthesize.ts) serves 48 kHz for
 * Hume and Gradium and 16 kHz for Amazon Polly. A response at any other rate is
 * resampled to this one rather than rejected — see
 * {@link SpekoTTSChunkedStream}. Any provider that emits `audio/mpeg` is still
 * rejected: v1 ships no MP3 decoder.
 */
const DEFAULT_SAMPLE_RATE = 24_000;
const NUM_CHANNELS = 1;

/**
 * The gateway reports the routed provider's real audio format on
 * `X-Speko-Audio-Format` as well as `Content-Type`. The header is the
 * authoritative field (an intermediary can rewrite `Content-Type`, and a
 * failover changes the rate without the caller ever asking for it), so read it
 * when the SDK surfaces it and fall back to `contentType` otherwise.
 *
 * The fallback is load-bearing, not defensive: `SynthesizeStreamResult` in
 * `@spekoai/sdk` 0.4.x/0.5.x exposes only `contentType`, and this adapter
 * supports that whole range. Since the gateway sets both fields to the same
 * value, the fallback is exact today; the header lookup is what keeps this
 * correct once the SDK starts surfacing it.
 */
function resolveResponseAudioFormat(streamed: SynthesizeStreamResult): string {
  const source = streamed as unknown as {
    audioFormat?: unknown;
    headers?: Record<string, unknown>;
  };
  if (typeof source.audioFormat === 'string' && source.audioFormat.length > 0) {
    return source.audioFormat;
  }
  const header = source.headers?.['x-speko-audio-format'];
  if (typeof header === 'string' && header.length > 0) return header;
  return streamed.contentType;
}

export interface SpekoTTSOptions {
  speko: Speko;
  intent: Intent;
  /** Optional Speko voice session id forwarded for usage attribution. */
  sessionId?: string;
  /** Voice id override forwarded to the Speko proxy. */
  voice?: string;
  /** Forwarded speech speed override. */
  speed?: number;
  /**
   * Forwarded speaking-style instruction (tone/pace/emotion). The Speko router
   * applies it only when the resolved TTS model is instruction-capable, so it's
   * safe to set unconditionally.
   */
  instructions?: string;
  /**
   * Output sample rate advertised to the LiveKit agent. Every frame this
   * instance emits is at this rate: a routed provider that produces a different
   * rate (48 kHz Hume/Gradium, 16 kHz Polly) is resampled to it. Defaults to
   * 24000, which most providers emit natively and therefore costs no resampling.
   */
  sampleRate?: number;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
}

/**
 * LiveKit Agents TTS adapter that delegates synthesis to the Speko proxy
 * (`POST /v1/synthesize`). The router picks the best TTS provider per intent
 * and fails over automatically.
 *
 * The Speko REST response streams audio bytes. This class is still wrapped
 * with `tts.StreamAdapter` + a sentence tokenizer to plug into a
 * `voice.AgentSession`, or use `createSpekoComponents()` which does that for
 * you.
 *
 * **Audio format constraint**: the adapter accepts either `audio/pcm;rate=NNNN`
 * or `audio/wav`. The Speko router asks every supported TTS for PCM upstream
 * (Cartesia natively, ElevenLabs via `output_format=pcm_24000`), so MP3 should
 * never reach the adapter in v1; if it does, `decodeSynthesisResult` throws.
 *
 * **Sample rate**: the response rate is read per request and resampled to the
 * declared {@link SpekoTTSOptions.sampleRate}, so routing to a 48 kHz or 16 kHz
 * provider — or failing over onto one mid-call, which the caller never sees — is
 * handled rather than fatal.
 */
export class SpekoTTS extends tts.TTS {
  label = 'speko.TTS';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #sessionId: string | undefined;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #instructions?: string;
  readonly #sampleRate: number;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(options: SpekoTTSOptions) {
    validateIntent(options.intent);
    const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    super(sampleRate, NUM_CHANNELS, { streaming: false });
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#sessionId = options.sessionId;
    this.#voice = options.voice;
    this.#speed = options.speed;
    this.#instructions = options.instructions;
    this.#sampleRate = sampleRate;
    this.#constraints = options.constraints;
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
      sessionId: this.#sessionId,
      voice: this.#voice,
      speed: this.#speed,
      instructions: this.#instructions,
      expectedSampleRate: this.#sampleRate,
      constraints: this.#constraints,
      connOptions,
      abortSignal,
    });
  }

  override stream(_options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    throw new Error(
      'SpekoTTS does not support native text-input streaming; it synthesizes one sentence request at a time. ' +
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
  sessionId?: string;
  voice?: string;
  speed?: number;
  instructions?: string;
  expectedSampleRate: number;
  constraints?: PipelineConstraints;
  connOptions?: APIConnectOptions;
  abortSignal?: AbortSignal;
}

export class SpekoTTSChunkedStream extends tts.ChunkedStream {
  label = 'speko.TTSChunkedStream';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #sessionId: string | undefined;
  readonly #voice?: string;
  readonly #speed?: number;
  readonly #instructions?: string;
  readonly #expectedSampleRate: number;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(args: SpekoTTSChunkedStreamArgs) {
    super(args.text, args.tts, args.connOptions, args.abortSignal);
    this.#speko = args.speko;
    this.#intent = args.intent;
    this.#sessionId = args.sessionId;
    this.#voice = args.voice;
    this.#speed = args.speed;
    this.#instructions = args.instructions;
    this.#expectedSampleRate = args.expectedSampleRate;
    this.#constraints = args.constraints;
  }

  protected async run(): Promise<void> {
    try {
      await this.#synthesize();
    } catch (err) {
      // A barge-in aborts the in-flight synthesis mid-stream — that is a normal
      // user action, not a provider fault. Returning (not throwing) prevents the
      // framework from emitting a spurious recoverable:false TTS error that,
      // after a few back-to-back interruptions, would exhaust the session's
      // error budget and close the live call.
      if (this.abortSignal?.aborted || isAbortError(err)) {
        log().info('[SpekoTTS] synthesize:aborted (barge-in)');
        return;
      }
      // Otherwise hand the framework a classified APIError so its maxRetry loop
      // runs: transient faults (5xx/429/empty-audio/connection-drop) retry, and
      // only a genuinely permanent fault surfaces recoverable:false. A bare
      // Error here would skip retries and close the session on the first blip.
      throw toFrameworkApiError(err);
    }
  }

  async #synthesize(): Promise<void> {
    // Diagnostic logging is intentionally verbose around the synthesize
    // boundary because the LiveKit Agents framework emits "TTS stream
    // stalled after producing audio, forcing close" with zero context
    // about which sentence stalled or what content-type came back. With
    // these logs we can grep the worker container for `[SpekoTTS]` and
    // see the full timeline per turn.
    const logger = log();
    const requestId = crypto.randomUUID();
    const t0 = Date.now();
    logger.info(
      {
        requestId,
        textLength: this.inputText.length,
        textPreview: this.inputText.slice(0, 80),
        voice: this.#voice,
        language: this.#intent.language,
        optimizeFor: this.#intent.optimizeFor,
        constraints: this.#constraints,
        expectedSampleRate: this.#expectedSampleRate,
      },
      '[SpekoTTS] synthesize:start',
    );

    let streamed: SynthesizeStreamResult;
    try {
      streamed = await this.#speko.synthesizeStream(
        this.inputText,
        {
          language: this.#intent.language,
          ...(this.#intent.region !== undefined && { region: this.#intent.region }),
          ...(this.#intent.optimizeFor !== undefined && {
            optimizeFor: this.#intent.optimizeFor,
          }),
          ...(this.#voice !== undefined && { voice: this.#voice }),
          ...(this.#sessionId !== undefined && { sessionId: this.#sessionId }),
          ...(this.#speed !== undefined && { speed: this.#speed }),
          ...(this.#instructions !== undefined && { instructions: this.#instructions }),
          ...(this.#constraints !== undefined && { constraints: this.#constraints }),
          // Voice agents speak LLM output, so always request spoken-form
          // normalization (markdown/number scrub) — the deterministic safety net
          // beneath the voice directive. Server kill-switch: SPEKO_SPOKEN_FORM_ENABLED=false.
          spokenForm: true,
        },
        this.abortSignal,
      );
    } catch (err) {
      // Let the run() wrapper swallow a barge-in abort silently — logging it as
      // an error would be misleading noise (a normal interruption, not a fault).
      if (this.abortSignal?.aborted || isAbortError(err)) throw err;
      logger.error(
        {
          requestId,
          elapsedMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        },
        '[SpekoTTS] synthesize:error',
      );
      throw err;
    }

    const t1 = Date.now();
    // Branch and rate-detect off the SAME resolved format string so the two can
    // never disagree about what arrived.
    const audioFormat = resolveResponseAudioFormat(streamed);
    if (audioFormat.toLowerCase().startsWith('audio/pcm')) {
      await this.#streamPcmResult(streamed, audioFormat, requestId, t0, t1);
      return;
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamed) chunks.push(chunk);
    const result: SynthesizeResult = {
      audio: concatChunks(chunks),
      contentType: streamed.contentType,
      provider: streamed.provider,
      model: streamed.model,
      failoverCount: streamed.failoverCount,
      scoresRunId: streamed.scoresRunId,
    };
    logger.info(
      {
        requestId,
        elapsedMs: t1 - t0,
        contentType: result.contentType,
        audioBytes: result.audio.byteLength,
        provider: result.provider,
      },
      '[SpekoTTS] synthesize:response',
    );

    const { pcm, sampleRate, channels } = decodeSynthesisResult(result, audioFormat);

    // Frame at the rate the bytes are actually in, then normalize to the rate
    // this instance advertises. Historically a difference threw here, which
    // aborted the utterance for every 48 kHz (Hume, Gradium) or 16 kHz (Polly)
    // route and for any invisible failover onto one.
    const samplesPerFrame = Math.round(sampleRate / 50);
    const bstream = new AudioByteStream(sampleRate, channels, samplesPerFrame);
    const decoded = [...bstream.write(pcm), ...bstream.flush()];
    const normalizer = createSampleRateNormalizer(sampleRate, this.#expectedSampleRate, channels);
    let frames: AudioFrame[];
    try {
      if (normalizer.resampling) {
        logger.info(
          {
            requestId,
            responseSampleRate: sampleRate,
            declaredSampleRate: this.#expectedSampleRate,
            provider: result.provider,
          },
          '[SpekoTTS] synthesize:resampling',
        );
      }
      frames = [...decoded.flatMap((frame) => normalizer.push(frame)), ...normalizer.flush()];
    } finally {
      normalizer.close();
    }

    if (frames.length === 0) {
      logger.error({ requestId }, '[SpekoTTS] synthesize:empty-frames');
      // Empty audio is a transient provider glitch — retryable so the framework
      // re-requests (and the router can fail over) instead of closing the call.
      throw new APIError('SpekoTTS: provider returned empty audio', { retryable: true });
    }

    logger.info(
      {
        requestId,
        frameCount: frames.length,
        sampleRate: this.#expectedSampleRate,
        responseSampleRate: sampleRate,
        channels,
        pcmBytes: pcm.byteLength,
        durationMs: Math.round((pcm.byteLength / 2 / sampleRate) * 1000),
        decodeMs: Date.now() - t1,
      },
      '[SpekoTTS] synthesize:frames-ready',
    );

    this.#pushFrames(frames, requestId);

    logger.info({ requestId, totalElapsedMs: Date.now() - t0 }, '[SpekoTTS] synthesize:done');
  }

  async #streamPcmResult(
    streamed: SynthesizeStreamResult,
    audioFormat: string,
    requestId: string,
    startedAt: number,
    responseAt: number,
  ): Promise<void> {
    const logger = log();
    const responseSampleRate = pcmSampleRateFromContentType(
      audioFormat.toLowerCase(),
      this.#expectedSampleRate,
    );
    // Frame the bytes at the rate they are actually in, then normalize to the
    // rate this instance advertises. A difference used to abort the utterance,
    // which killed every 48 kHz (Hume, Gradium) and 16 kHz (Polly) route.
    const normalizer = createSampleRateNormalizer(
      responseSampleRate,
      this.#expectedSampleRate,
      NUM_CHANNELS,
    );
    if (normalizer.resampling) {
      logger.info(
        {
          requestId,
          responseSampleRate,
          declaredSampleRate: this.#expectedSampleRate,
          provider: streamed.provider,
        },
        '[SpekoTTS] synthesize:resampling (streaming)',
      );
    }

    const samplesPerFrame = Math.round(responseSampleRate / 50);
    const bstream = new AudioByteStream(responseSampleRate, NUM_CHANNELS, samplesPerFrame);
    // Providers (Cartesia, EL) emit 4-5x faster than realtime, so pushing every
    // frame the instant it arrives floods the playout pipeline with seconds of
    // audio ahead — which keeps draining after a barge-in (server yields in ~70ms
    // but the buffered audio plays on). Pace the push to stay at most
    // LOOKAHEAD_MS ahead of realtime so a barge-in has ~nothing to drain.
    // Starvation-safe: we only ever DELAY when ahead, never when behind, so TTFB
    // and under-realtime providers are unaffected.
    const LOOKAHEAD_MS = 150;
    let pending: AudioFrame | undefined;
    let pushed = 0;
    let bytes = 0;
    // Playout time already queued. Accumulated from each frame's real duration
    // rather than `pushed * 20ms` because a resampled frame is not necessarily
    // 20ms long; at equal rates the two are identical.
    let queuedMs = 0;
    let firstFrameMs: number | undefined;
    const playoutStart = Date.now();
    const flush = async (final: boolean) => {
      const frame = pending;
      if (!frame) return;
      // How far the queued audio's playout runs ahead of realtime.
      const aheadMs = queuedMs - (Date.now() - playoutStart);
      if (aheadMs > LOOKAHEAD_MS) {
        await new Promise((resolve) => setTimeout(resolve, aheadMs - LOOKAHEAD_MS));
      }
      this.queue.put({
        requestId,
        segmentId: requestId,
        frame,
        final,
      });
      pending = undefined;
      pushed += 1;
      queuedMs += (frame.samplesPerChannel / frame.sampleRate) * 1000;
      firstFrameMs ??= Date.now() - startedAt;
    };
    // One frame is always held back so the last one can be marked `final`.
    const offer = async (frame: AudioFrame) => {
      await flush(false);
      pending = frame;
    };

    try {
      for await (const chunk of streamed) {
        bytes += chunk.byteLength;
        for (const frame of bstream.write(chunk)) {
          for (const out of normalizer.push(frame)) await offer(out);
        }
      }
      for (const frame of bstream.flush()) {
        for (const out of normalizer.push(frame)) await offer(out);
      }
      for (const out of normalizer.flush()) await offer(out);
      await flush(true);
    } finally {
      normalizer.close();
    }

    if (pushed === 0) {
      logger.error({ requestId, responseSampleRate, bytes }, '[SpekoTTS] synthesize:empty-frames');
      // Empty audio is a transient provider glitch — retryable so the framework
      // re-requests (and the router can fail over) instead of closing the call.
      // Also reachable when a very short utterance is entirely swallowed by the
      // resampler's warm-up; from the caller's seat that is the same outage.
      throw new APIError(
        `SpekoTTS: provider returned empty audio (responseRate=${responseSampleRate}, ` +
          `declaredRate=${this.#expectedSampleRate}, bytes=${bytes})`,
        { retryable: true },
      );
    }

    logger.info(
      {
        requestId,
        responseMs: responseAt - startedAt,
        firstFrameMs,
        totalElapsedMs: Date.now() - startedAt,
        frameCount: pushed,
        pcmBytes: bytes,
        sampleRate: this.#expectedSampleRate,
        responseSampleRate,
        provider: streamed.provider,
      },
      '[SpekoTTS] synthesize:streamed-pcm-done',
    );
  }

  #pushFrames(frames: AudioFrame[], requestId: string): void {
    const logger = log();
    const t0 = Date.now();
    let pushed = 0;
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
      pushed += 1;
    };

    for (const frame of frames) {
      flush(false);
      pending = frame;
    }
    flush(true);

    logger.info(
      {
        requestId,
        pushedCount: pushed,
        expectedCount: frames.length,
        pushMs: Date.now() - t0,
      },
      '[SpekoTTS] pushFrames:done',
    );
  }
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
 * The returned `sampleRate` is whatever the response declares; the caller is
 * responsible for normalizing it to the rate the TTS advertises.
 *
 * @param audioFormat Optional override for the format string to branch on,
 *   normally the response's `X-Speko-Audio-Format`. Defaults to
 *   `result.contentType`.
 *
 * Exported for unit testing.
 */
export function decodeSynthesisResult(
  result: SynthesizeResult,
  audioFormat?: string,
): {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
} {
  const format = audioFormat ?? result.contentType;
  const contentType = format.toLowerCase();

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
      throw new SpekoAdapterError(
        `SpekoTTS: WAV response has ${channels} channels but the adapter is ` +
          `configured for ${NUM_CHANNELS}. Configure the Speko router to return ` +
          `mono audio, or pin a mono-only provider.`,
        'UNSUPPORTED_CHANNELS',
      );
    }
    return { pcm, sampleRate, channels };
  }

  if (contentType.startsWith('audio/mpeg')) {
    throw new SpekoAdapterError(
      `SpekoTTS: received ${format} from provider "${result.provider}". ` +
        'v1 only supports raw PCM (`audio/pcm;rate=NNNN`) and WAV (`audio/wav`). ' +
        'Configure your Speko routing intent so Cartesia is preferred, or pin the ' +
        'TTS provider explicitly.',
      'UNSUPPORTED_CONTENT_TYPE',
    );
  }

  throw new SpekoAdapterError(
    `SpekoTTS: unsupported content type "${format}" from provider ` +
      `"${result.provider}". Expected audio/pcm, audio/wav, or (in future) audio/mpeg.`,
    'UNSUPPORTED_CONTENT_TYPE',
  );
}
