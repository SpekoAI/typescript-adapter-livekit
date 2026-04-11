import { stt, tokenize, tts } from '@livekit/agents';
import type { VAD } from '@livekit/agents';
import type { Speko } from '@speko/sdk';

import { type Intent } from './intent.js';
import { SpekoLLM, type SpekoLLMOptions } from './llm.js';
import { SpekoSTT } from './stt.js';
import { SpekoTTS, type SpekoTTSOptions } from './tts.js';

export interface CreateSpekoComponentsOptions {
  /** Initialised Speko client from `@speko/sdk`. */
  speko: Speko;
  /** Routing hint used for every proxy call. */
  intent: Intent;
  /**
   * VAD instance used to segment user audio into utterances before calling
   * Speko's buffered `/v1/transcribe`. Typically `await silero.VAD.load()`.
   */
  vad: VAD;
  /** Optional voice override passed through to the TTS. */
  voice?: string;
  /**
   * Optional sentence tokenizer for TTS chunking. Defaults to the built-in
   * basic sentence tokenizer from `@livekit/agents`.
   */
  sentenceTokenizer?: tokenize.SentenceTokenizer;
  /** Optional LLM tuning forwarded to `/v1/complete`. */
  llm?: Pick<SpekoLLMOptions, 'temperature' | 'maxTokens'>;
  /** Optional TTS tuning (output sample rate, speed) forwarded to the TTS. */
  ttsOptions?: Pick<SpekoTTSOptions, 'sampleRate' | 'speed'>;
}

export interface SpekoComponents {
  /** STT wrapped with `stt.StreamAdapter(…, vad)`. Drop straight into `AgentSession`. */
  stt: stt.StreamAdapter;
  /** LLM that calls Speko's `/v1/complete`. */
  llm: SpekoLLM;
  /** TTS wrapped with `tts.StreamAdapter(…, sentenceTokenizer)`. */
  tts: tts.StreamAdapter;
}

/**
 * Build a `{ stt, llm, tts }` bundle ready to slot into a LiveKit
 * `voice.AgentSession`. The STT and TTS are wrapped with the framework's
 * `StreamAdapter` helpers so that Speko's buffered proxy can participate in a
 * streaming pipeline: STT+VAD buffers utterances turn-by-turn; TTS splits
 * completion text by sentence before each `/v1/synthesize` call.
 *
 * @example
 * ```ts
 * import { voice, defineAgent } from '@livekit/agents';
 * import * as silero from '@livekit/agents-plugin-silero';
 * import { Speko } from '@speko/sdk';
 * import { createSpekoComponents } from '@speko/adapter-livekit';
 *
 * export default defineAgent({
 *   prewarm: async (proc) => {
 *     proc.userData.vad = await silero.VAD.load();
 *   },
 *   entry: async (ctx) => {
 *     const speko = new Speko({ apiKey: process.env.SPEKO_API_KEY! });
 *     const { stt, llm, tts } = createSpekoComponents({
 *       speko,
 *       intent: { language: 'en-US', vertical: 'general' },
 *       vad: ctx.proc.userData.vad,
 *     });
 *     const session = new voice.AgentSession({ vad: ctx.proc.userData.vad, stt, llm, tts });
 *     await session.start({ agent: new voice.Agent({ instructions: 'Be helpful.' }), room: ctx.room });
 *     await ctx.connect();
 *   },
 * });
 * ```
 */
export function createSpekoComponents(
  options: CreateSpekoComponentsOptions,
): SpekoComponents {
  const sttOptions = { speko: options.speko, intent: options.intent };
  const llmOptions: SpekoLLMOptions = {
    speko: options.speko,
    intent: options.intent,
    ...(options.llm?.temperature !== undefined && { temperature: options.llm.temperature }),
    ...(options.llm?.maxTokens !== undefined && { maxTokens: options.llm.maxTokens }),
  };
  const ttsOptions: SpekoTTSOptions = {
    speko: options.speko,
    intent: options.intent,
    ...(options.voice !== undefined && { voice: options.voice }),
    ...(options.ttsOptions?.speed !== undefined && { speed: options.ttsOptions.speed }),
    ...(options.ttsOptions?.sampleRate !== undefined && { sampleRate: options.ttsOptions.sampleRate }),
  };

  const spekoSTT = new SpekoSTT(sttOptions);
  const spekoLLM = new SpekoLLM(llmOptions);
  const spekoTTS = new SpekoTTS(ttsOptions);

  const sentenceTokenizer =
    options.sentenceTokenizer ?? new tokenize.basic.SentenceTokenizer();

  return {
    stt: new stt.StreamAdapter(spekoSTT, options.vad),
    llm: spekoLLM,
    tts: new tts.StreamAdapter(spekoTTS, sentenceTokenizer),
  };
}
