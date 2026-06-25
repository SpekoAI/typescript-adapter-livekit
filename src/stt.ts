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
import { type Intent, validateIntent } from './intent.js';

export interface SpekoSTTOptions {
  /** Initialised Speko client from `@spekoai/sdk`. */
  speko: Speko;
  /** Routing hint sent with every transcription. */
  intent: Intent;
  /** Optional allow-list constraints. */
  constraints?: PipelineConstraints;
  /**
   * Optional domain keywords forwarded to the underlying provider for
   * vocabulary biasing. Casing is preserved for proper nouns.
   */
  keywords?: readonly string[];
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
   * Optional session id, used purely to tag the streaming-STT log lines so a
   * given call's reconnect / give-up activity can be bucketed in aggregated
   * logs (SPE-121 — before this, a `[speko.SpeechStream]` line carried no
   * call identity, so a 1011 storm couldn't be attributed to a session).
   */
  sessionId?: string;
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
  readonly #constraints: PipelineConstraints | undefined;
  readonly #keywords: readonly string[] | undefined;
  readonly #streaming: boolean;
  readonly #baseUrl: string | undefined;
  readonly #apiKey: string | undefined;
  readonly #sessionId: string | undefined;

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
    this.#constraints = options.constraints;
    this.#keywords = options.keywords && options.keywords.length > 0 ? options.keywords : undefined;
    this.#streaming = streaming;
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.#sessionId = options.sessionId;
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
    const result = await this.#speko.transcribe(
      wav,
      {
        language: this.#intent.language,
        ...(this.#intent.region !== undefined && { region: this.#intent.region }),
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
        contentType: 'audio/wav',
        ...(this.#constraints !== undefined && { constraints: this.#constraints }),
        ...(this.#keywords !== undefined && { keywords: this.#keywords }),
      },
      abortSignal,
    );

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
    return new SpekoSpeechStream(this, {
      baseUrl: this.#baseUrl,
      apiKey: this.#apiKey,
      intent: this.#intent,
      constraints: this.#constraints,
      keywords: this.#keywords,
      ...(this.#sessionId !== undefined && { sessionId: this.#sessionId }),
      ...(options?.connOptions ? { connOptions: options.connOptions } : {}),
    });
  }
}

// --- streaming WebSocket SpeechStream --------------------------------------

interface SpekoSpeechStreamOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly intent: Intent;
  readonly constraints: PipelineConstraints | undefined;
  readonly keywords: readonly string[] | undefined;
  /** Session id for log tagging (SPE-121 observability). */
  readonly sessionId?: string;
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
}

export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  maxConsecutive: 5,
  healthyMs: 10_000,
  openTimeoutMs: 10_000,
};

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

  constructor(sttImpl: SpekoSTT, opts: SpekoSpeechStreamOptions) {
    super(sttImpl);
    this.#sttImpl = sttImpl;
    this.#opts = opts;
    this.#language = asLanguageCode(opts.intent.language);
    this.#policy = { ...DEFAULT_RECONNECT_POLICY, ...(opts.reconnect ?? {}) };
    this.#createWebSocket = opts.createWebSocket ?? defaultCreateWebSocket;
    this.#sessionId = opts.sessionId;
  }

  protected async run(): Promise<void> {
    // The framework feeds frames into `this.input`. We must drain it exactly
    // once across the whole session (it can't be re-iterated), so the input
    // iterator lives outside the reconnect loop: a reconnect resumes consuming
    // from wherever the previous socket left off.
    const inputIterator = this.input[Symbol.asyncIterator]();
    let inputDone = false;
    let consecutiveFailures = 0;
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
          this.#giveUp(error, everPumpedAudio);
          break;
        }
        const backoffMs = reconnectBackoffMs(consecutiveFailures, this.#policy);
        this.#log(
          `reconnecting (attempt ${consecutiveFailures}/${this.#policy.maxConsecutive}, audioReceived=${everPumpedAudio}) in ${backoffMs}ms after: ${error.message}`,
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
    const ws = this.#createWebSocket(url, { Authorization: `Bearer ${this.#opts.apiKey}` });
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
              // The Speko proxy flushes on its own cadence; a flush sentinel is
              // an utterance boundary hint with no wire frame. Nothing to send.
              continue;
            }
            const frame = value;
            if (ws.readyState !== WS_OPEN) break;
            if (!headerSent) {
              ws.send(buildStreamingWavHeader(frame.sampleRate, frame.channels));
              headerSent = true;
            }
            ws.send(pcmBytes(frame));
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
          this.#log(`server error frame: ${typeof message === 'string' ? message : 'unknown'}`);
        } else if (kind === 'end') {
          // Server finished. If our input is also done, this is a clean end.
          if (inputFinished) {
            try {
              ws.close(1000, 'done');
            } catch {
              // ignore
            }
            settle(true);
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
    };
  }

  #emitTranscript(frame: ServerTranscriptFrame): void {
    if (this.queue.closed) return;
    const text = frame.text ?? '';
    const isFinal = frame.isFinal === true;
    if (!text && !isFinal) return;
    // Map per-word timings into TimedString[] when the gateway forwarded them.
    // LiveKit's adaptive interruption detector aligns these against the audio
    // clock; SpeechData.startTime/endTime span the whole utterance.
    const words = frame.words?.length
      ? frame.words.map((w) =>
          createTimedString({
            text: w.text,
            startTime: w.start,
            endTime: w.end,
            ...(Number.isFinite(w.confidence) ? { confidence: w.confidence } : {}),
          }),
        )
      : undefined;
    const speechData: stt.SpeechData = {
      language: this.#language,
      text,
      startTime: words?.length ? (words[0]?.startTime ?? 0) : 0,
      endTime: words?.length ? (words[words.length - 1]?.endTime ?? 0) : 0,
      confidence: Number.isFinite(frame.confidence) ? frame.confidence : 1,
      ...(words ? { words } : {}),
    };
    if (!this.#speaking) {
      this.#speaking = true;
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH });
    }
    if (isFinal) {
      this.queue.put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, alternatives: [speechData] });
      this.#speaking = false;
      this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
    } else {
      this.queue.put({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, alternatives: [speechData] });
    }
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
  #giveUp(error: Error, audioReceived: boolean): void {
    this.#log(
      `giving up after ${this.#policy.maxConsecutive} consecutive reconnect attempts ` +
        `(audioReceived=${audioReceived}) — the live session will stop receiving transcripts ` +
        `(last error: ${error.message})`,
    );
    this.#surfaceSessionError(
      new Error(
        `Speko streaming STT permanently lost after ${this.#policy.maxConsecutive} reconnect attempts: ${error.message}`,
      ),
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
