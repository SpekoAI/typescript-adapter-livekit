import type { AudioBuffer } from '@livekit/agents';
import { type APIConnectOptions, asLanguageCode, stt } from '@livekit/agents';
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
}

/**
 * LiveKit Agents STT adapter that delegates recognition to the Speko proxy
 * (`POST /v1/transcribe`). The Speko router picks the best STT provider per
 * `(language, region, optimizeFor)` and handles failover.
 *
 * Declares `{ streaming: false }` because this adapter uploads one
 * VAD-bounded WAV per recognition call. The underlying `/v1/transcribe`
 * response streams transcript events, and the SDK aggregates the final result
 * for `_recognize()`. Wrap with `stt.StreamAdapter` + a VAD (e.g. Silero) to
 * plug into a `voice.AgentSession`; `createSpekoComponents()` does that for you.
 */
export class SpekoSTT extends stt.STT {
  label = 'speko.STT';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #constraints: PipelineConstraints | undefined;
  readonly #keywords: readonly string[] | undefined;

  constructor(options: SpekoSTTOptions) {
    super({ streaming: false, interimResults: false });
    validateIntent(options.intent);
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#constraints = options.constraints;
    this.#keywords = options.keywords && options.keywords.length > 0 ? options.keywords : undefined;
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

  override stream(_options?: { connOptions?: APIConnectOptions }): stt.SpeechStream {
    throw new Error(
      'SpekoSTT does not support native microphone streaming; it uploads one VAD-bounded utterance. ' +
        'Wrap this instance with `new stt.StreamAdapter(spekoStt, vad)` from ' +
        '@livekit/agents, or pass it through `createSpekoComponents()` which ' +
        'returns a ready-to-use StreamAdapter-wrapped STT.',
    );
  }
}
