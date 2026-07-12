import type { AudioBuffer } from '@livekit/agents';
import {
  type APIConnectOptions,
  asLanguageCode,
  createTimedString,
  type LanguageCode,
  stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import type { PipelineConstraints, Speko } from '@spekoai/sdk';

import { framesToWav } from './audio.js';
import { isAbortError, toFrameworkApiError } from './errors.js';
import { type Intent, validateIntent } from './intent.js';

export interface SpekoSTTOptions {
  /** Initialised Speko client from `@spekoai/sdk`. */
  speko: Speko;
  /** Routing hint sent with every transcription. */
  intent: Intent;
  /**
   * Optional Speko voice session id. Forwarded with every transcription for
   * usage attribution, and used to tag the streaming-STT log lines so a given
   * call's reconnect / give-up activity can be bucketed in aggregated logs
   * (SPE-121 — before this a `[speko.SpeechStream]` line carried no call
   * identity, so a 1011 storm couldn't be attributed to a session).
   */
  sessionId?: string;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
  /**
   * Optional domain keywords forwarded to the underlying provider for
   * vocabulary biasing. Casing is preserved for proper nouns.
   */
  keywords?: readonly string[];
  /**
   * Optional language override forwarded only to the selected STT provider.
   * Routing and transcript language labels continue to use {@link intent}.
   */
  language?: string;
  /**
   * Enable native microphone streaming via the Speko proxy's
   * `GET /v1/transcribe/stream` WebSocket endpoint. When `true`, this STT
   * declares `{ streaming: true }` and `stream()` opens a long-lived WS that
   * streams raw PCM and emits interim + final transcripts as the provider
   * produces them — no VAD-bounded buffering. When `false` (default for direct
   * construction), the adapter uploads one VAD-bounded WAV per turn via
   * `_recognize()` and must be wrapped with `stt.StreamAdapter`.
   *
   * `streaming` requires {@link baseUrl} and {@link apiKey} so the stream can
   * open its own WebSocket — the `Speko` SDK client does not expose them.
   */
  streaming?: boolean;
  /**
   * Speko proxy base URL (e.g. `https://api.speko.dev`). Required when
   * {@link streaming} is `true`. Threaded explicitly because the SDK client
   * keeps its base URL private. Ignored in batch mode.
   */
  baseUrl?: string;
  /**
   * Speko API key (Bearer). Required when {@link streaming} is `true`.
   * Threaded explicitly because the SDK client keeps its key private. Ignored
   * in batch mode.
   */
  apiKey?: string;
  /**
   * Declare `alignedTranscript: 'word'` in this STT's capabilities. Defaults to
   * `false`. ONLY set this `true` when {@link streaming} is `true` AND the call
   * is pinned (via {@link constraints}) to a single provider that actually
   * emits word timings (Deepgram or ElevenLabs Scribe realtime).
   *
   * Why it must be gated: LiveKit reads `alignedTranscript` STATICALLY from
   * capabilities (at session construction) to decide whether to enable its
   * adaptive (ML) interruption detector, but Speko routing picks the provider
   * PER CALL. If we declared `'word'` unconditionally and a call routed to a
   * non-word provider (cartesia, kotib, google), we'd promise word timings we
   * never deliver — LiveKit's detector would then see empty `words` arrays.
   * `createSpekoComponents` only flips this true when the constraints pin a
   * single known word-emitter; ad-hoc construction leaves it false (safe).
   */
  alignedTranscript?: boolean;
  /**
   * Test seam: WebSocket factory forwarded to every stream created by
   * {@link SpekoSTT.stream}. Production leaves this unset (global WHATWG
   * WebSocket).
   * @internal
   */
  createWebSocket?: WebSocketFactory;
  /**
   * Test seam: reconnect policy overrides forwarded to every stream created by
   * {@link SpekoSTT.stream}.
   * @internal
   */
  reconnect?: Partial<ReconnectPolicy>;
}

/**
 * LiveKit Agents STT adapter that delegates recognition to the Speko proxy.
 *
 * Two modes:
 *
 *   - Batch (default): uploads one VAD-bounded WAV per recognition call to
 *     `POST /v1/transcribe`. Declares `{ streaming: false }`; wrap with
 *     `stt.StreamAdapter` + a VAD to plug into a `voice.AgentSession`.
 *
 *   - Streaming (`{ streaming: true }`): opens a long-lived WebSocket to
 *     `GET /v1/transcribe/stream`, sends a WAV header then raw PCM, and emits
 *     interim + final transcripts as the provider produces them. Declares
 *     `{ streaming: true, interimResults: true }` and can be dropped straight
 *     into a `voice.AgentSession` (no `StreamAdapter` wrapper).
 *
 * The router picks the best STT provider per `(language, region, optimizeFor)`
 * and handles failover.
 */
export class SpekoSTT extends stt.STT {
  label = 'speko.STT';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #sessionId: string | undefined;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #keywords: readonly string[] | undefined;
  readonly #sttLanguage: string | undefined;
  readonly #streaming: boolean;
  readonly #baseUrl: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #alignedTranscript: boolean;
  readonly #createWebSocket: WebSocketFactory | undefined;
  readonly #reconnect: Partial<ReconnectPolicy> | undefined;
  /**
   * Live streams handed out by {@link stream}. Session-scoped (one stream per
   * call in practice); pruned lazily in {@link flushActiveStreams}, so a
   * retired stream never pins memory past the next flush attempt.
   */
  readonly #activeStreams = new Set<SpekoSpeechStream>();

  constructor(options: SpekoSTTOptions) {
    const streaming = options.streaming ?? false;
    // Only advertise word-aligned transcripts when we're streaming AND the
    // caller has confirmed the pinned provider emits word timings. Declaring
    // it is the precondition for LiveKit's adaptive interruption detector
    // (`resolveInterruptionDetector` requires `capabilities.alignedTranscript`).
    const alignedTranscript: 'word' | false =
      streaming && options.alignedTranscript === true ? 'word' : false;
    super({ streaming, interimResults: streaming, alignedTranscript });
    validateIntent(options.intent);
    if (streaming) {
      if (!options.baseUrl) {
        throw new Error(
          'SpekoSTT: streaming mode requires `baseUrl` (the SDK client does not expose it). ' +
            'Pass the same base URL you used to construct the Speko client.',
        );
      }
      if (!options.apiKey) {
        throw new Error(
          'SpekoSTT: streaming mode requires `apiKey` (the SDK client does not expose it). ' +
            'Pass the same API key you used to construct the Speko client.',
        );
      }
    }
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#sessionId = options.sessionId;
    this.#constraints = options.constraints;
    this.#keywords = options.keywords && options.keywords.length > 0 ? options.keywords : undefined;
    this.#sttLanguage = options.language;
    this.#streaming = streaming;
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#alignedTranscript = alignedTranscript === 'word';
    this.#createWebSocket = options.createWebSocket;
    this.#reconnect = options.reconnect;
  }

  override get provider(): string {
    return 'speko';
  }

  override get model(): string {
    return 'speko-router';
  }

  protected async _recognize(
    frame: AudioBuffer,
    abortSignal?: AbortSignal,
  ): Promise<stt.SpeechEvent> {
    const wav = framesToWav(frame);
    let result;
    try {
      result = await this.#speko.transcribe(
        wav,
        {
          language: this.#intent.language,
          ...(this.#intent.region !== undefined && { region: this.#intent.region }),
          ...(this.#intent.optimizeFor !== undefined && {
            optimizeFor: this.#intent.optimizeFor,
          }),
          contentType: 'audio/wav',
          ...(this.#sessionId !== undefined && { sessionId: this.#sessionId }),
          ...(this.#constraints !== undefined && { constraints: this.#constraints }),
          ...(this.#keywords !== undefined && { keywords: this.#keywords }),
          ...(this.#sttLanguage !== undefined && {
            sttOptions: { language: this.#sttLanguage },
          }),
        },
        abortSignal,
      );
    } catch (err) {
      // An abort (barge-in) propagates unchanged for the framework to handle.
      // Any other fault becomes a classified APIError so the batch STT retry
      // loop engages (a transient transcribe blip retries instead of being
      // reported as recoverable:false — which for STT closes the call instantly,
      // since the AgentSession gives STT no error budget).
      if (isAbortError(err) || abortSignal?.aborted) throw err;
      throw toFrameworkApiError(err);
    }

    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          text: result.text,
          language: asLanguageCode(this.#intent.language),
          startTime: 0,
          endTime: 0,
          confidence: result.confidence ?? 1,
        },
      ],
    };
  }

  override stream(options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    if (!this.#streaming) {
      throw new Error(
        'SpekoSTT (batch mode) does not support native microphone streaming; it uploads one ' +
          'VAD-bounded utterance. Either construct with `{ streaming: true, baseUrl, apiKey }`, ' +
          'wrap this instance with `new stt.StreamAdapter(spekoStt, vad)` from @livekit/agents, ' +
          'or pass it through `createSpekoComponents()`.',
      );
    }
    if (!this.#baseUrl || !this.#apiKey) {
      // Unreachable: the constructor rejects streaming without both. Kept as a
      // type guard so the options object below needs no non-null assertions.
      throw new Error('SpekoSTT: streaming requires baseUrl and apiKey');
    }
    const stream = new SpekoSpeechStream(this, {
      baseUrl: this.#baseUrl,
      apiKey: this.#apiKey,
      intent: this.#intent,
      sessionId: this.#sessionId,
      constraints: this.#constraints,
      keywords: this.#keywords,
      ...(this.#sttLanguage !== undefined && { language: this.#sttLanguage }),
      alignedTranscript: this.#alignedTranscript,
      ...(this.#createWebSocket ? { createWebSocket: this.#createWebSocket } : {}),
      ...(this.#reconnect ? { reconnect: this.#reconnect } : {}),
      ...(options?.connOptions ? { connOptions: options.connOptions } : {}),
    });
    this.#activeStreams.add(stream);
    return stream;
  }

  /**
   * Push the framework's FLUSH_SENTINEL into every live stream. The worker
   * calls this at VAD end-of-speech: the @livekit/agents voice pipeline never
   * flushes a native streaming STT itself (it only flushes the batch
   * StreamAdapter), so without this nudge a provider that endpoints
   * server-side (navai, smallest/pulse) finalizes on its OWN silence timer,
   * ~1-3s after the caller stopped — the dominant EOU latency term. No-op per
   * stream once it is closed or its input has ended; retired streams are
   * pruned here.
   */
  flushActiveStreams(): void {
    for (const stream of this.#activeStreams) {
      if (stream.isRetired) {
        this.#activeStreams.delete(stream);
        continue;
      }
      try {
        stream.flush();
      } catch {
        // flush() throws once the stream/input closed between the guard and
        // the call — the stream is done; drop it and move on.
        this.#activeStreams.delete(stream);
      }
    }
  }
}

// --- streaming WebSocket SpeechStream --------------------------------------

interface SpekoSpeechStreamOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly intent: Intent;
  /** Session id for usage attribution + log tagging (SPE-121 observability). */
  readonly sessionId?: string;
  readonly constraints: PipelineConstraints | undefined;
  readonly keywords: readonly string[] | undefined;
  readonly language?: string;
  /**
   * Mirror of the parent STT's word-alignment capability. On aligned streams
   * the config frame requests interim results (the adaptive interruption
   * detector needs word-timed transcripts DURING overlap, not ~0.5-1s later at
   * the final), and words-less frames get guarded timings — LiveKit's
   * `flushHeldTranscripts` treats a `startTime === endTime === 0` alternative
   * as "no timestamps" and discards the ENTIRE held buffer of user speech.
   */
  readonly alignedTranscript?: boolean;
  readonly connOptions?: APIConnectOptions;
  /**
   * Reconnect policy override. Production uses {@link DEFAULT_RECONNECT_POLICY};
   * tests shrink the delays/budget so the exhaustion path runs fast.
   */
  readonly reconnect?: Partial<ReconnectPolicy>;
  /**
   * WebSocket factory override (defaults to the global WHATWG `WebSocket`). Lets
   * a test drive the reconnect / backoff / give-up paths with a fake socket and
   * no network.
   */
  readonly createWebSocket?: WebSocketFactory;
  /** Clock override (defaults to `Date.now`). Tests inject a fake to make the
   * aligned-stream timestamp rebasing deterministic. */
  readonly now?: () => number;
}

/** Per-word timing on a transcript frame, in SECONDS. */
interface ServerTranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence?: number;
}

/** Server→client frame from `GET /v1/transcribe/stream`. */
interface ServerTranscriptFrame {
  type: 'transcript';
  text: string;
  isFinal: boolean;
  confidence: number;
  // Present only when the upstream provider emits word timings. When present,
  // mapped into `SpeechData.words` (TimedString[]) so LiveKit's adaptive
  // interruption detector can align the transcript against the audio.
  words?: ServerTranscriptWord[];
}

const WAV_HEADER_BYTES = 44;
const WAV_PCM_FORMAT = 1;
const WAV_BITS_PER_SAMPLE = 16;
// Streaming PCM is open-ended: we don't know the total length up front, so the
// RIFF/data chunk sizes are written as the canonical "streaming/unknown"
// sentinel. The server only reads `byteRate` (offset 28) for billing and never
// trusts these size fields, so 0xFFFFFFFF is safe and self-documenting.
const WAV_STREAMING_SIZE = 0xffffffff;
// WHATWG WebSocket.readyState OPEN.
const WS_OPEN = 1;

/**
 * Reconnect resilience policy. A transient socket drop (a network blip, a
 * gateway pod cycling, the now-fixed server-side 4401 auth race) must NEVER
 * permanently deafen a live call, so we reconnect with jittered exponential
 * backoff and a budget that RESETS after any connection that stayed healthy for
 * a while — a long call with occasional drops can't exhaust a fixed count. A
 * truly dead endpoint still gives up after `maxConsecutive` rapid failures (so
 * we don't spin forever), and giving up surfaces a recoverable:false error to
 * the session instead of going silently quiet.
 */
export interface ReconnectPolicy {
  /** Base backoff before exponential growth + jitter. */
  baseDelayMs: number;
  /** Backoff ceiling. */
  maxDelayMs: number;
  /** Consecutive failures (with no healthy connection between them) before giving up. */
  maxConsecutive: number;
  /** A connection open at least this long resets the consecutive-failure budget. */
  healthyMs: number;
  /** If the socket never opens within this, fail it so a half-open socket can't hang run(). */
  openTimeoutMs: number;
  /**
   * Absolute cap on TOTAL reconnects across the whole call, independent of the
   * healthy-stretch reset. The consecutive-failure budget resets after any
   * healthy+audio connection, so a socket that recycles every ~11s would
   * otherwise reconnect FOREVER — deaf for a window each cycle — and never give
   * up. This bounds the lifetime churn: a chronic flap escalates (gives up)
   * instead of silently degrading the call forever.
   */
  maxLifetime: number;
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxConsecutive: 5,
  healthyMs: 10_000,
  openTimeoutMs: 10_000,
  maxLifetime: 50,
};

/**
 * WebSocket close codes that signal a PERMANENT failure — reconnecting can
 * never recover, so burning the reconnect budget on them just adds ~10-15s of
 * caller-facing dead air before the inevitable give-up. 4401 = unauthorized
 * (stale/revoked key), 4400 = invalid config, 1008 = policy violation. Transient
 * codes (1006 abnormal, 1011 server error) are NOT here — those reconnect.
 */
const PERMANENT_WS_CLOSE_CODES = new Set([4401, 4400, 1008]);

/** A reconnect failure the run loop must NOT retry (permanent close code). */
class PermanentStreamError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentStreamError';
  }
}

function isPermanentStreamError(err: unknown): boolean {
  return (
    err instanceof PermanentStreamError ||
    (typeof err === 'object' && err !== null && (err as { permanent?: unknown }).permanent === true)
  );
}

/** The `stt_error` payload shape, derived from the exported callback type. */
type SttErrorEvent = Parameters<stt.STTCallbacks['error']>[0];

/**
 * Jittered exponential backoff for reconnect attempt `attempt` (1-based). Full
 * jitter in [exp/2, exp] where exp = min(base * 2^(attempt-1), max), so many
 * concurrent sessions don't reconnect in lockstep and hammer a recovering
 * gateway. Waiting this out with a REAL timer (see {@link SpekoSpeechStream})
 * also guarantees the reconnect loop yields to the macrotask queue every
 * iteration — it can never starve the worker event loop with a tight microtask
 * spin. `rng` is injectable for deterministic tests.
 */
export function reconnectBackoffMs(
  attempt: number,
  policy: Pick<ReconnectPolicy, 'baseDelayMs' | 'maxDelayMs'> = DEFAULT_RECONNECT_POLICY,
  rng: () => number = Math.random,
): number {
  const exp = Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
  const half = exp / 2;
  return Math.round(half + rng() * half);
}

/**
 * Build the `stt_error` event the AgentSession listens for on the STT instance
 * (`stt.on('error', …)`). Mirrors the framework's private `emitError` shape: we
 * cannot trigger that by throwing from `run()` because `run()` is fire-and-forget
 * via `startSoon` (a throw becomes an unhandled rejection), so emitting this
 * directly is how a permanently-dead stream is surfaced to the session instead
 * of silently going deaf. `recoverable: false` says it is gone for good.
 */
export function buildSttErrorEvent(label: string, error: Error): SttErrorEvent {
  return {
    type: 'stt_error',
    timestamp: Date.now(),
    label,
    error,
    recoverable: false,
  };
}

/** Factory for the streaming socket. Overridable so tests can drive it without a network. */
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

const defaultCreateWebSocket: WebSocketFactory = (url, headers) =>
  // Node 22+ ships a global WHATWG `WebSocket`; the worker runs on Node 24. Using
  // it avoids adding a `ws` dependency to this published package. The options arg
  // (headers) is a Node extension to the WHATWG ctor signature.
  new WebSocket(url, { headers } as unknown as string[]);

/** Best-effort unref so a pending timer never keeps the worker process alive. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Opt-in flush-endpoint path (read per-call so tests / runtime env changes take
 * effect without a re-import). When on, an utterance-boundary FLUSH_SENTINEL —
 * pushed by the worker at VAD end-of-speech (the 1.5.0 voice pipeline never
 * flushes a native streaming STT itself) — is forwarded to the proxy as a
 * `{type:'flush'}` frame; default off → the sentinel is swallowed exactly as
 * before. See SPEKO_STT_FLUSH_ENDPOINT.
 */
export function sttFlushEndpointEnabled(): boolean {
  return process.env.SPEKO_STT_FLUSH_ENDPOINT === 'true';
}

/**
 * Long-lived streaming STT over the Speko proxy WebSocket. LiveKit calls
 * `stream()` once per session and keeps the returned `SpeechStream` for the
 * whole call, pushing every captured `AudioFrame` into `this.input`. So this
 * connection is session-scoped, not per-turn: we hold one WS open and let the
 * upstream provider segment utterances and emit interim/final transcripts.
 *
 * Resilience contract (per spec): a WS failure must NOT crash the session. On
 * any socket error or unexpected close we log loudly, attempt a bounded
 * reconnect, and if reconnects are exhausted we return cleanly from `run()` —
 * which closes the output queue (an implicit "end"), so the AgentSession keeps
 * running (silently deaf) rather than throwing.
 */
export class SpekoSpeechStream extends stt.SpeechStream {
  label = 'speko.SpeechStream';
  readonly #sttImpl: SpekoSTT;
  readonly #opts: SpekoSpeechStreamOptions;
  readonly #language: LanguageCode;
  readonly #policy: ReconnectPolicy;
  readonly #createWebSocket: WebSocketFactory;
  readonly #sessionId: string | undefined;
  #speaking = false;
  readonly #now: () => number;
  /**
   * Session epoch (ms): when this stream was created — the closest observable
   * to LiveKit's session-scoped input clock (`_inputStartedAt`). All aligned
   * timestamps are expressed as seconds since this epoch.
   */
  readonly #streamEpochMs: number;
  /**
   * Session-relative seconds at the CURRENT connection's audio start. Provider
   * word timings restart at ~0 on every gateway connection, but the reconnect
   * loop is invisible to LiveKit, whose `audio_recognition` compares timings
   * against the session-scoped clock — un-rebased post-reconnect timings map
   * into the deep past of its echo ignore-window, so every held barge-in
   * transcript would be discarded for the rest of the call. Rebased in
   * `ws.onopen` for every connection; applied to emitted timings only on
   * aligned streams (non-aligned emission is unchanged).
   */
  #connEpochOffsetS = 0;
  #framesReceived = 0;
  #finalsReceived = 0;
  #emptyFinalsDropped = 0;
  #emptyInterimsDropped = 0;
  #transcriptsEmitted = 0;
  #audioMsPumped = 0;
  #alignedRebaseApplied = 0;
  #alignedWordStartOffsetMinS: number | null = null;
  #alignedWordStartOffsetMaxS: number | null = null;
  #summaryLogged = false;

  /**
   * True once this stream can no longer accept input (closed, or the
   * framework ended the input queue). `closed`/`input` are protected on the
   * base class, so the owning {@link SpekoSTT} needs this to prune its
   * active-stream registry without calling `flush()` into a throw.
   */
  get isRetired(): boolean {
    return this.closed || this.input.closed;
  }

  constructor(sttImpl: SpekoSTT, opts: SpekoSpeechStreamOptions) {
    super(sttImpl);
    this.#sttImpl = sttImpl;
    this.#opts = opts;
    this.#language = asLanguageCode(opts.intent.language);
    this.#policy = { ...DEFAULT_RECONNECT_POLICY, ...(opts.reconnect ?? {}) };
    this.#createWebSocket = opts.createWebSocket ?? defaultCreateWebSocket;
    this.#sessionId = opts.sessionId;
    this.#now = opts.now ?? Date.now;
    this.#streamEpochMs = this.#now();
  }

  protected async run(): Promise<void> {
    try {
      await this.#runUntilDone();
    } finally {
      this.#logSummary();
    }
  }

  override close(): void {
    super.close();
    // Fallback summary for a wedged connection: run()'s finally logs the
    // complete counters first when the loop unwinds promptly (#summaryLogged
    // dedupes); this only fires if it never does.
    const fallback = setTimeout(() => this.#logSummary(), 250);
    fallback.unref?.();
  }

  async #runUntilDone(): Promise<void> {
    // The framework feeds frames into `this.input`. We must drain it exactly
    // once across the whole session (it can't be re-iterated), so the input
    // iterator lives outside the reconnect loop: a reconnect resumes consuming
    // from wherever the previous socket left off.
    const inputIterator = this.input[Symbol.asyncIterator]();
    let inputDone = false;
    let consecutiveFailures = 0;
    // Total reconnects across the whole call — the lifetime cap (#13) so a
    // connection that flaps every ~healthyMs can't reset the consecutive budget
    // forever and churn for the entire call.
    let totalReconnects = 0;
    // Whether ANY connection in this stream's life carried real audio. Surfaced
    // in the give-up log so a never-heard stream (leaked/duplicate, or an
    // unsubscribed caller track) is distinguishable from a genuinely failing
    // live call.
    let everPumpedAudio = false;

    while (!this.closed && !inputDone) {
      const connectionStartedAt = Date.now();
      const progress = { audioPumped: false };
      try {
        inputDone = await this.#runOneConnection(inputIterator, progress);
        consecutiveFailures = 0; // clean end / success
      } catch (err) {
        // Loud, never fatal. Log for observability, then decide whether to
        // reconnect (with backoff) or give up (surfacing an error event).
        const error = err instanceof Error ? err : new Error(String(err));
        if (progress.audioPumped) everPumpedAudio = true;
        this.#emitError(error);
        if (this.closed || inputDone) break;

        // A permanent close (auth/config/policy) will never recover. Giving it
        // the full reconnect budget just burns ~10-15s of caller-facing dead air
        // before the inevitable give-up — fail fast with a clear diagnostic (#11).
        if (isPermanentStreamError(error)) {
          this.#giveUp(error, everPumpedAudio, 'permanent');
          break;
        }

        // Lifetime cap (#13): a connection that recycles every ~healthyMs would
        // reset the consecutive budget on every survival and reconnect for the
        // whole call (deaf for a window each cycle). Bound TOTAL reconnects so a
        // chronic flap escalates instead of churning silently forever.
        totalReconnects += 1;
        if (totalReconnects > this.#policy.maxLifetime) {
          this.#giveUp(error, everPumpedAudio, 'flapping');
          break;
        }

        // Reset the budget ONLY when the dropped connection both stayed up a
        // healthy stretch AND actually carried audio. A connection that opened
        // but pumped ZERO audio — a leaked/duplicate stream, or a call whose
        // caller track never subscribed — is NOT healthy: healthyMs (~10s)
        // equals the upstream's no-audio idle timeout, so before this guard such
        // a stream 1011'd at ~10s, reset the budget purely by surviving, and
        // reconnected FOREVER (SPE-121: heavy 1011 spam, even on idle workers).
        // Requiring real audio means a no-audio stream exhausts the budget and
        // gives up after maxConsecutive instead of looping.
        if (Date.now() - connectionStartedAt >= this.#policy.healthyMs && progress.audioPumped) {
          consecutiveFailures = 0;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures > this.#policy.maxConsecutive) {
          this.#giveUp(error, everPumpedAudio, 'exhausted');
          break;
        }
        const backoffMs = reconnectBackoffMs(consecutiveFailures, this.#policy);
        this.#log(
          `[phase=retrying] reconnecting (attempt ${consecutiveFailures}/${this.#policy.maxConsecutive}, ` +
            `total=${totalReconnects}/${this.#policy.maxLifetime}, audioReceived=${everPumpedAudio}) ` +
            `in ${backoffMs}ms after: ${error.message}`,
        );
        await this.#sleep(backoffMs);
      }
    }

    // If we stopped reconnecting while audio is still flowing (we gave up), keep
    // draining the framework's input queue in the background so it can't grow
    // unbounded for the rest of the call — the base class's `pumpInput` keeps
    // feeding it regardless of whether `run()` is still consuming. A dead STT
    // stream must never wedge or balloon the job. Returning from `run()` also
    // closes the output queue (an implicit end-of-stream); we never re-throw — a
    // dead WS must not take down the call.
    if (!inputDone && !this.closed) {
      void this.#drainAfterGiveUp(inputIterator);
    }
  }

  /**
   * Open one WebSocket, send config + audio, and forward transcripts until the
   * input is exhausted or the socket closes. Resolves `true` when the input
   * iterator finished (clean end, no reconnect). Rejects on a reconnectable
   * socket failure with input still pending.
   */
  #runOneConnection(
    inputIterator: AsyncIterator<AudioFrame | typeof stt.SpeechStream.FLUSH_SENTINEL>,
    progress: { audioPumped: boolean },
  ): Promise<boolean> {
    const url = toWsUrl(this.#opts.baseUrl);
    const ws = this.#createWebSocket(url, this.#webSocketHeaders());
    ws.binaryType = 'arraybuffer';

    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let headerSent = false;
      let inputFinished = false;
      let pumping = false;
      let opened = false;
      let openTimer: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(openTimer);
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      };
      const settle = (value: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Best-effort close so a half-open / abandoned socket doesn't leak.
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      // Watchdog: a socket that never opens (half-open TCP, a black-holed proxy)
      // would never fire open/close/error, so this promise would hang forever —
      // silently deafening the call with no reconnect. Time it out into a
      // reconnectable failure so the run loop can back off and retry.
      openTimer = setTimeout(() => {
        if (!opened) {
          fail(
            new Error(
              `Speko streaming STT WebSocket did not open within ${this.#policy.openTimeoutMs}ms`,
            ),
          );
        }
      }, this.#policy.openTimeoutMs);
      unrefTimer(openTimer);

      // Drain `this.input`, sending a WAV header (sized for streaming) on the
      // first real frame, then raw PCM per frame. Runs concurrently with
      // message receipt; the awaited iterator naturally backpressures.
      const pumpAudio = async () => {
        pumping = true;
        try {
          while (true) {
            const result = await inputIterator.next();
            if (result.done) {
              inputFinished = true;
              break;
            }
            const value = result.value;
            if (value === stt.SpeechStream.FLUSH_SENTINEL) {
              // Utterance boundary from the worker's VAD end-of-speech signal
              // (via SpekoSTT.flushActiveStreams). By default there's no wire
              // frame for it. When the flush-endpoint path is on
              // (SPEKO_STT_FLUSH_ENDPOINT), forward it as a {type:'flush'} frame
              // so a provider whose own endpointing lags (navai, smallest/pulse)
              // can finalize on this semantic turn signal instead of waiting out
              // its server-side silence timer. The server ignores it unless the
              // pinned provider is flush-capable, so this is safe for every
              // other provider; off by default → unchanged.
              if (sttFlushEndpointEnabled() && ws.readyState === WS_OPEN) {
                ws.send(JSON.stringify({ type: 'flush' }));
              }
              continue;
            }
            const frame = value;
            if (ws.readyState !== WS_OPEN) break;
            if (!headerSent) {
              ws.send(buildStreamingWavHeader(frame.sampleRate, frame.channels));
              headerSent = true;
            }
            ws.send(pcmBytes(frame));
            this.#audioMsPumped += audioFrameDurationMs(frame);
            // Mark that this connection carried real audio — the run loop uses
            // this to decide whether a drop counts as a "healthy" reconnect or
            // whether a no-audio stream should give up (SPE-121).
            progress.audioPumped = true;
          }
          if (inputFinished && ws.readyState === WS_OPEN) {
            ws.send(JSON.stringify({ type: 'end' }));
          }
        } catch (err) {
          // A failure pumping audio (e.g. send on a closing socket) is
          // reconnectable; let onclose/onerror drive the outcome.
          this.#log(`audio pump error: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      ws.onopen = () => {
        opened = true;
        clearTimeout(openTimer);
        // Rebase the connection clock: this connection's audio (and so the
        // provider's word timings) starts ~now, this many seconds into the
        // session. ~0 for the first connection; the elapsed call time after a
        // transparent reconnect.
        this.#connEpochOffsetS = (this.#now() - this.#streamEpochMs) / 1000;
        try {
          ws.send(JSON.stringify(this.#configFrame()));
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        void pumpAudio();
      };

      ws.onmessage = (evt: MessageEvent) => {
        if (typeof evt.data !== 'string') return; // server only sends TEXT frames
        let frame: unknown;
        try {
          frame = JSON.parse(evt.data);
        } catch {
          return;
        }
        const kind = (frame as { type?: unknown }).type;
        if (kind === 'transcript') {
          this.#emitTranscript(frame as ServerTranscriptFrame);
        } else if (kind === 'error') {
          const message = (frame as { message?: unknown }).message;
          // Log the structured failure code alongside the message so a
          // stale-BYOK / quota / 1011 death is attributable to a class rather
          // than just a free-text string (#12).
          const code = (frame as { code?: unknown }).code;
          this.#log(
            `[phase=retrying] server error frame: code=${typeof code === 'string' ? code : 'unknown'} ` +
              `message=${typeof message === 'string' ? message : 'unknown'}`,
          );
        } else if (kind === 'end') {
          // Server finished. If our input is also done, this is a clean end.
          if (inputFinished) {
            try {
              ws.close(1000, 'done');
            } catch {
              // ignore
            }
            settle(true);
          } else {
            // Server ended the stream mid-call while we still have audio to send
            // — the upstream provider dropped us. Treat it as a reconnectable
            // failure rather than ignoring it (which parked run() on a half-dead
            // socket, deaf until a later 1011 finally fired) (#14).
            fail(new Error('Speko streaming STT server ended the stream mid-call'));
          }
        }
        // `ready` is informational; nothing to do.
      };

      ws.onerror = () => {
        // The Event carries no useful detail in the WHATWG API; onclose follows
        // with a code. Treat as reconnectable unless input already finished.
        if (inputFinished) {
          settle(true);
        } else {
          fail(new Error('Speko streaming STT WebSocket error'));
        }
      };

      ws.onclose = (evt: CloseEvent) => {
        // A permanent close (auth/config/policy) can never recover — surface it
        // as a non-reconnectable failure so the run loop gives up immediately
        // instead of burning the reconnect budget on a guaranteed-dead endpoint
        // (#11). Checked first so it applies even on a close-before-open.
        if (PERMANENT_WS_CLOSE_CODES.has(evt.code)) {
          fail(
            new PermanentStreamError(
              `Speko streaming STT WebSocket closed permanently (code ${evt.code})`,
            ),
          );
          return;
        }
        if (!pumping) {
          // Closed before we ever opened/pumped — reconnectable.
          fail(new Error(`Speko streaming STT WebSocket closed before open (code ${evt.code})`));
          return;
        }
        // Clean close after we sent everything, or input is done → finished.
        if (inputFinished || evt.code === 1000) {
          settle(true);
          return;
        }
        // Dropped mid-session with input still flowing → reconnect.
        fail(new Error(`Speko streaming STT WebSocket closed unexpectedly (code ${evt.code})`));
      };
    });
  }

  #configFrame() {
    return {
      type: 'config' as const,
      language: this.#opts.intent.language,
      ...(this.#opts.intent.region !== undefined && { region: this.#opts.intent.region }),
      ...(this.#opts.intent.optimizeFor !== undefined && {
        optimizeFor: this.#opts.intent.optimizeFor,
      }),
      ...(this.#opts.constraints !== undefined && { constraints: this.#opts.constraints }),
      ...(this.#opts.keywords !== undefined && { keywords: this.#opts.keywords }),
      ...(this.#opts.language !== undefined && {
        sttOptions: { language: this.#opts.language },
      }),
      ...(this.#opts.alignedTranscript ? { interimResults: true } : {}),
    };
  }

  #webSocketHeaders(): Record<string, string> {
    const trimmedSessionId = this.#opts.sessionId?.trim();
    return {
      Authorization: `Bearer ${this.#opts.apiKey}`,
      ...(trimmedSessionId ? { 'x-session-id': trimmedSessionId } : {}),
    };
  }

  #emitTranscript(frame: ServerTranscriptFrame): void {
    if (this.queue.closed) return;
    this.#framesReceived += 1;
    const text = frame.text ?? '';
    const isFinal = frame.isFinal === true;
    if (isFinal) this.#finalsReceived += 1;
    if (!text && !isFinal) {
      this.#emptyInterimsDropped += 1;
      return;
    }
    // Map per-word timings into TimedString[] when the gateway forwarded them.
    // LiveKit's adaptive interruption detector aligns these against the audio
    // clock; SpeechData.startTime/endTime span the whole utterance. On aligned
    // streams every timing is rebased onto the SESSION clock (provider timings
    // are connection-relative and restart on reconnect — see #connEpochOffsetS);
    // non-aligned streams keep the raw provider timings, byte-for-byte.
    const aligned = this.#opts.alignedTranscript === true;
    const offsetS = aligned ? this.#connEpochOffsetS : 0;
    // A word without finite timings would propagate NaN into every framework
    // comparison — drop it (the gateway wire contract never emits one).
    const timedWords = frame.words?.filter(
      (w) => Number.isFinite(w.start) && Number.isFinite(w.end),
    );
    const words = timedWords?.length
      ? timedWords.map((w) =>
          createTimedString({
            text: w.text,
            startTime: w.start + offsetS,
            endTime: w.end + offsetS,
            ...(Number.isFinite(w.confidence) ? { confidence: w.confidence } : {}),
          }),
        )
      : undefined;
    let startTime = 0;
    let endTime = 0;
    if (words?.length) {
      startTime = words[0]?.startTime ?? 0;
      endTime = words[words.length - 1]?.endTime ?? 0;
      if (aligned) {
        this.#alignedRebaseApplied += 1;
        for (const word of words) this.#recordAlignedWordStartOffset(word.startTime ?? Number.NaN);
      }
      // Same 0/0-sentinel insurance as the words-less branch, for the
      // theoretical zero-duration-word-at-0 + same-millisecond-onopen case.
      if (aligned) endTime = Math.max(endTime, 0.001);
    } else if (aligned) {
      // Words-less frame on a word-aligned stream: Deepgram emits empty finals
      // during silence; ElevenLabs realtime interims carry text but no words.
      // LiveKit's flushHeldTranscripts treats a startTime === endTime === 0
      // alternative as "no timestamps" and drops the ENTIRE held buffer —
      // every word the user spoke over the agent. An empty frame outside
      // speech carries no information, so skip it; any other words-less frame
      // is stamped at the session clock "now" (≈ the end of the audio it
      // transcribes, one transcription delay late) so it stays orderable and
      // can never look like pre-playback echo.
      if (!text && !this.#speaking) {
        this.#emptyFinalsDropped += 1;
        return;
      }
      // Floor at 1ms: a frame landing in the epoch's own millisecond must
      // still never produce the 0/0 sentinel.
      const nowS = Math.max((this.#now() - this.#streamEpochMs) / 1000, 0.001);
      startTime = nowS;
      endTime = nowS;
    }
    const speechData: stt.SpeechData = {
      language: this.#language,
      text,
      startTime,
      endTime,
      confidence: Number.isFinite(frame.confidence) ? frame.confidence : 1,
      ...(words ? { words } : {}),
    };
    if (!this.#speaking) {
      this.#speaking = true;
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }
    if (isFinal) {
      this.queue.put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [speechData] });
      this.#transcriptsEmitted += 1;
      this.#speaking = false;
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    } else {
      this.queue.put({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [speechData] });
      this.#transcriptsEmitted += 1;
    }
  }

  #recordAlignedWordStartOffset(startTime: number): void {
    if (!Number.isFinite(startTime)) return;
    this.#alignedWordStartOffsetMinS =
      this.#alignedWordStartOffsetMinS === null
        ? startTime
        : Math.min(this.#alignedWordStartOffsetMinS, startTime);
    this.#alignedWordStartOffsetMaxS =
      this.#alignedWordStartOffsetMaxS === null
        ? startTime
        : Math.max(this.#alignedWordStartOffsetMaxS, startTime);
  }

  #emitError(error: Error): void {
    // Per-failure observability. The run() loop owns recovery (reconnect with
    // backoff); a permanent give-up additionally surfaces a session error via
    // #giveUp. The loud log is the per-attempt channel.
    this.#log(`error: ${error.message}`);
  }

  /**
   * Reconnects are exhausted with audio still flowing. Log loudly AND surface a
   * recoverable:false error to the AgentSession so the call doesn't just go
   * silently deaf — the session's error handler sees a real STT error event.
   */
  #giveUp(
    error: Error,
    audioReceived: boolean,
    reason: 'exhausted' | 'permanent' | 'flapping' = 'exhausted',
  ): void {
    this.#log(
      `[phase=fatal] giving up (reason=${reason}, audioReceived=${audioReceived}) — the live ` +
        `session will stop receiving transcripts (last error: ${error.message})`,
    );
    this.#surfaceSessionError(
      new Error(`Speko streaming STT permanently lost (${reason}): ${error.message}`),
    );
  }

  /**
   * Emit the framework's `stt_error` event on the STT instance so the
   * AgentSession's error handler observes it. We can't throw from run() (it's
   * fire-and-forget via startSoon → unhandled rejection) and the base class's
   * emitError is private, so this is the safe surfacing path. Best-effort:
   * surfacing must never break the run loop.
   */
  #surfaceSessionError(error: Error): void {
    try {
      this.#sttImpl.emit('error', buildSttErrorEvent(this.label, error));
    } catch {
      // ignore — observability must not take down the call
    }
  }

  /** A real timer-backed sleep — guarantees the reconnect loop yields the event loop. */
  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      unrefTimer(setTimeout(resolve, ms));
    });
  }

  /**
   * After giving up, keep consuming `this.input` to nowhere until the stream is
   * closed. The base class's pumpInput keeps feeding the queue for the rest of
   * the call; draining it prevents unbounded growth without re-opening a socket.
   */
  async #drainAfterGiveUp(
    inputIterator: AsyncIterator<AudioFrame | typeof stt.SpeechStream.FLUSH_SENTINEL>,
  ): Promise<void> {
    try {
      while (!this.closed) {
        const { done } = await inputIterator.next();
        if (done) break;
      }
    } catch {
      // Stream torn down — nothing to do.
    }
  }

  #log(message: string): void {
    // Loud, per the spec — a streaming-STT failure should be obvious in logs.
    // Tag with the session id (when known) so a 1011 storm in aggregated logs
    // can be attributed to a specific call rather than being un-bucketable
    // (SPE-121).
    const tag = this.#sessionId ? `speko.SpeechStream ${this.#sessionId}` : 'speko.SpeechStream';
    console.error(`[${tag}] ${message}`);
  }

  #logSummary(): void {
    if (this.#summaryLogged) return;
    this.#summaryLogged = true;
    const summary = {
      marker: 'stt_stream_summary',
      label: this.label,
      sessionId: this.#sessionId ?? null,
      framesReceived: this.#framesReceived,
      finalsReceived: this.#finalsReceived,
      emptyFinalsDropped: this.#emptyFinalsDropped,
      emptyInterimsDropped: this.#emptyInterimsDropped,
      transcriptsEmitted: this.#transcriptsEmitted,
      audioMsPumped: Math.round(this.#audioMsPumped),
      alignedRebaseApplied: this.#alignedRebaseApplied,
      alignedWordStartOffsetMinS: this.#alignedWordStartOffsetMinS,
      alignedWordStartOffsetMaxS: this.#alignedWordStartOffsetMaxS,
    };
    const line = JSON.stringify(summary);
    if (summary.transcriptsEmitted === 0 && this.#audioMsPumped > 15_000) {
      console.warn(line);
    } else {
      console.info(line);
    }
  }
}

function toWsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const ws = trimmed.replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`);
  return `${ws}/v1/transcribe/stream`;
}

/** Raw PCM bytes backing a frame's Int16 samples, offset/length-safe. */
function pcmBytes(frame: AudioFrame): Uint8Array {
  const data = frame.data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function audioFrameDurationMs(frame: AudioFrame): number {
  return frame.sampleRate > 0 ? (frame.samplesPerChannel / frame.sampleRate) * 1000 : 0;
}

/**
 * A 44-byte PCM16 WAV header with streaming-sentinel sizes (0xFFFFFFFF). The
 * proxy reads `byteRate` for duration billing and ignores the size fields, so
 * an open-ended stream is expressed by leaving the sizes "unknown".
 */
export function buildStreamingWavHeader(sampleRate: number, channels: number): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(out.buffer);
  const byteRate = (sampleRate * channels * WAV_BITS_PER_SAMPLE) / 8;
  const blockAlign = (channels * WAV_BITS_PER_SAMPLE) / 8;

  writeAscii(out, 0, 'RIFF');
  view.setUint32(4, WAV_STREAMING_SIZE, true);
  writeAscii(out, 8, 'WAVE');
  writeAscii(out, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, WAV_PCM_FORMAT, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);
  writeAscii(out, 36, 'data');
  view.setUint32(40, WAV_STREAMING_SIZE, true);
  return out;
}

function writeAscii(buf: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    buf[offset + i] = text.charCodeAt(i);
  }
}
