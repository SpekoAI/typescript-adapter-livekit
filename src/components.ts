import type { VAD } from '@livekit/agents';
import { stt, type tokenize, tts } from '@livekit/agents';
import type { ChatTool, PipelineConstraints, Speko } from '@spekoai/sdk';

import type { Intent } from './intent.js';
import { SpekoLLM, type SpekoLLMOptions } from './llm.js';
import { createDefaultSentenceTokenizer } from './sentence-tokenizer.js';
import { SpekoSTT, type SpekoSTTOptions } from './stt.js';
import { SpekoTTS, type SpekoTTSOptions } from './tts.js';

/**
 * Streaming STT providers whose gateway frames carry word-level timestamps.
 * Only these may enable `alignedTranscript` (and thus adaptive interruption);
 * others stream text-only and must NOT claim word alignment. Keep in sync with
 * which provider adapters populate `SttEvent.words`.
 */
const WORD_TIMESTAMP_STT_PROVIDERS = new Set(['deepgram', 'elevenlabs', 'smallest', 'cartesia']);

export interface CreateSpekoComponentsOptions {
  /** Initialised Speko client from `@spekoai/sdk`. */
  speko: Speko;
  /** Routing hint used for every proxy call. */
  intent: Intent;
  /** Active Speko voice session id, forwarded to proxy calls for usage attribution. */
  sessionId?: string;
  /**
   * VAD instance used to segment user audio into utterances before calling
   * SpekoSTT uploads one VAD-bounded utterance to `/v1/transcribe`.
   * Typically `await silero.VAD.load()`.
   */
  vad: VAD;
  /** Optional voice override passed through to the TTS. */
  voice?: string;
  /**
   * Optional allow-list constraints shared by STT/LLM/TTS calls. The router
   * still ranks by benchmark score but picks only from `allowedProviders[modality]`.
   */
  constraints?: PipelineConstraints;
  /**
   * Optional sentence tokenizer for TTS chunking. Defaults to the built-in
   * basic sentence tokenizer from `@livekit/agents`.
   */
  sentenceTokenizer?: tokenize.SentenceTokenizer;
  /** Optional LLM tuning forwarded to `/v1/complete`. */
  llm?: Pick<SpekoLLMOptions, 'temperature' | 'maxTokens'>;
  /** Optional per-session tools supplied by a pre-call config webhook. */
  tools?: ChatTool[];
  /**
   * Optional TTS tuning (output sample rate, speed, speaking-style instruction)
   * forwarded to the TTS. `instructions` sets the initial value; callers can
   * update it later via `components.ttsProvider.setInstructions(...)`.
   */
  ttsOptions?: Pick<SpekoTTSOptions, 'sampleRate' | 'speed' | 'instructions'>;
  /**
   * Optional STT tuning. `keywords` provides domain-vocabulary biasing and
   * `language` overrides only the underlying provider's stream language; the
   * routing intent remains unchanged. Forwarded via `speko.transcribe`.
   */
  sttOptions?: Pick<SpekoSTTOptions, 'keywords' | 'language'>;
  /**
   * Use the Speko proxy's native streaming STT WebSocket
   * (`GET /v1/transcribe/stream`) instead of the VAD-bounded batch upload path.
   * Defaults to `true`.
   *
   *   - `true`  → `components.stt` is a streaming {@link SpekoSTT} dropped
   *               straight into the session; transcripts arrive incrementally
   *               (interim + final) as the provider produces them. The session
   *               still uses the {@link vad} you pass for turn detection.
   *               Requires {@link sttBaseUrl} and {@link sttApiKey}.
   *   - `false` → `components.stt` is the original `stt.StreamAdapter` wrapping
   *               a batch SpekoSTT (one VAD-bounded WAV per turn). Unchanged.
   */
  sttStreaming?: boolean;
  /**
   * Speko proxy base URL for streaming STT (e.g. `https://api.speko.dev`).
   * Required when {@link sttStreaming} is `true` (the default). Threaded
   * explicitly because the `Speko` SDK client keeps its base URL private.
   */
  sttBaseUrl?: string;
  /**
   * Speko API key for streaming STT. Required when {@link sttStreaming} is
   * `true` (the default). Threaded explicitly because the `Speko` SDK client
   * keeps its key private.
   */
  sttApiKey?: string;
  /**
   * Enable the registered-tools loader. When set, the LLM loads the tools
   * registered for this `agentId` via `speko.agents.tools.listChatTools(agentId)`
   * once per session and merges them with LiveKit's runtime ToolContext. Omit
   * to keep runtime-only behavior.
   */
  agentId?: string;
  /**
   * @deprecated Ignored. The loader now reads the base URL from the `speko`
   * client.
   */
  apiBaseUrl?: string;
  /**
   * @deprecated Ignored. The loader now reads the API key from the `speko`
   * client.
   */
  apiKey?: string;
  /** Called once if the registered-tools fetch fails (soft degradation). */
  onRegisteredToolsError?: (err: Error) => void;
  /** Optional SpekoLLM generation lifecycle hook. */
  onGenerationStarted?: SpekoLLMOptions['onGenerationStarted'];
  /** Optional SpekoLLM abort lifecycle hook. */
  onGenerationAborted?: SpekoLLMOptions['onGenerationAborted'];
}

export interface SpekoComponents {
  /**
   * STT, ready to drop into an `AgentSession`. When `sttStreaming` is `true`
   * (default) this is a streaming `SpekoSTT` (native WS); when `false` it's the
   * `stt.StreamAdapter`-wrapped batch path. Both satisfy `stt.STT`.
   */
  stt: stt.STT;
  /** LLM that calls Speko's `/v1/complete`. */
  llm: SpekoLLM;
  /** TTS wrapped with `tts.StreamAdapter(…, sentenceTokenizer)`. */
  tts: tts.StreamAdapter;
}

/**
 * Build a `{ stt, llm, tts }` bundle ready to slot into a LiveKit
 * `voice.AgentSession`. The STT and TTS are wrapped with the framework's
 * `StreamAdapter` helpers so that Speko's streaming REST proxy can participate in a
 * streaming pipeline: STT+VAD buffers utterances turn-by-turn; TTS splits
 * completion text by sentence before each `/v1/synthesize` call.
 *
 * @example
 * ```ts
 * import { voice, defineAgent } from '@livekit/agents';
 * import * as silero from '@livekit/agents-plugin-silero';
 * import { Speko } from '@spekoai/sdk';
 * import { createSpekoComponents } from '@spekoai/adapter-livekit';
 *
 * export default defineAgent({
 *   prewarm: async (proc) => {
 *     proc.userData.vad = await silero.VAD.load();
 *   },
 *   entry: async (ctx) => {
 *     const speko = new Speko({ apiKey: process.env.SPEKO_API_KEY! });
 *     const { stt, llm, tts } = createSpekoComponents({
 *       speko,
 *       intent: { language: 'en-US' },
 *       vad: ctx.proc.userData.vad,
 *     });
 *     const session = new voice.AgentSession({ vad: ctx.proc.userData.vad, stt, llm, tts });
 *     await session.start({ agent: new voice.Agent({ instructions: 'Be helpful.' }), room: ctx.room });
 *     await ctx.connect();
 *   },
 * });
 * ```
 */
export function createSpekoComponents(options: CreateSpekoComponentsOptions): SpekoComponents {
  const sttStreaming = options.sttStreaming ?? true;
  if (sttStreaming && (!options.sttBaseUrl || !options.sttApiKey)) {
    throw new Error(
      'createSpekoComponents: sttStreaming (the default) requires sttBaseUrl and sttApiKey — ' +
        'pass both, or set sttStreaming: false for the batch path.',
    );
  }
  // alignedTranscript (word timestamps) may only be declared when we can
  // guarantee the routed provider actually emits words — capabilities are read
  // STATICALLY by LiveKit before routing, so claiming 'word' for a provider
  // that won't deliver would feed the adaptive interruption detector empty
  // arrays. We only know the provider for certain when constraints pin exactly
  // one, and only the WORD_TIMESTAMP_STT_PROVIDERS emit word timings.
  // Pins may be bare ("deepgram") or model-qualified ("deepgram:nova-3" — the
  // dashboard always stores the qualified form), so compare the provider
  // prefix only.
  const pinnedStt = options.constraints?.allowedProviders?.stt;
  const [pinnedSttProvider = ''] = String(pinnedStt?.[0] ?? '')
    .trim()
    .toLowerCase()
    .split(':');
  const alignedTranscript =
    sttStreaming &&
    Array.isArray(pinnedStt) &&
    pinnedStt.length === 1 &&
    WORD_TIMESTAMP_STT_PROVIDERS.has(pinnedSttProvider);

  const sttOptions: SpekoSTTOptions = {
    speko: options.speko,
    intent: options.intent,
    ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
    ...(options.constraints !== undefined && { constraints: options.constraints }),
    ...(options.sttOptions?.keywords && options.sttOptions.keywords.length > 0
      ? { keywords: options.sttOptions.keywords }
      : {}),
    ...(options.sttOptions?.language !== undefined && {
      language: options.sttOptions.language,
    }),
    ...(sttStreaming && {
      streaming: true,
      baseUrl: options.sttBaseUrl,
      apiKey: options.sttApiKey,
      ...(alignedTranscript ? { alignedTranscript: true } : {}),
    }),
  };
  const llmOptions: SpekoLLMOptions = {
    speko: options.speko,
    intent: options.intent,
    ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
    ...(options.llm?.temperature !== undefined && { temperature: options.llm.temperature }),
    ...(options.llm?.maxTokens !== undefined && { maxTokens: options.llm.maxTokens }),
    ...(options.constraints !== undefined && { constraints: options.constraints }),
    ...(options.tools !== undefined && { tools: options.tools }),
    ...(options.agentId !== undefined && { agentId: options.agentId }),
    ...(options.onRegisteredToolsError !== undefined && {
      onRegisteredToolsError: options.onRegisteredToolsError,
    }),
    ...(options.onGenerationStarted !== undefined && {
      onGenerationStarted: options.onGenerationStarted,
    }),
    ...(options.onGenerationAborted !== undefined && {
      onGenerationAborted: options.onGenerationAborted,
    }),
  };
  const ttsOptions: SpekoTTSOptions = {
    speko: options.speko,
    intent: options.intent,
    ...(options.voice !== undefined && { voice: options.voice }),
    ...(options.ttsOptions?.speed !== undefined && { speed: options.ttsOptions.speed }),
    ...(options.ttsOptions?.sampleRate !== undefined && {
      sampleRate: options.ttsOptions.sampleRate,
    }),
    ...(options.ttsOptions?.instructions !== undefined && {
      instructions: options.ttsOptions.instructions,
    }),
    ...(options.constraints !== undefined && { constraints: options.constraints }),
    ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
  };

  const spekoSTT = new SpekoSTT(sttOptions);
  const spekoLLM = new SpekoLLM(llmOptions);
  const spekoTTS = new SpekoTTS(ttsOptions);

  // retainFormat keeps inter-sentence whitespace so the agent transcript (built
  // by concatenating these tokens) doesn't glue sentences together (SPE-141).
  const sentenceTokenizer = options.sentenceTokenizer ?? createDefaultSentenceTokenizer();

  return {
    // Streaming SpekoSTT manages its own WS lifecycle; the session still uses
    // the caller's VAD for endpointing. Batch mode keeps the StreamAdapter wrap.
    stt: sttStreaming ? spekoSTT : new stt.StreamAdapter(spekoSTT, options.vad),
    llm: spekoLLM,
    tts: new tts.StreamAdapter(spekoTTS, sentenceTokenizer),
  };
}
