import { asLanguageCode, stt, type APIConnectOptions } from '@livekit/agents';
import type { AudioBuffer } from '@livekit/agents';
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
}

/**
 * LiveKit Agents STT adapter that delegates recognition to the Speko proxy
 * (`POST /v1/transcribe`). The Speko router picks the best STT provider per
 * `(language, vertical, optimizeFor)` and handles failover.
 *
 * Declares `{ streaming: false }` — Speko's proxy is buffered turn-by-turn,
 * so this STT must be wrapped with `stt.StreamAdapter` + a VAD (e.g. Silero)
 * to plug into a `voice.AgentSession`. `createSpekoComponents()` does that
 * wrapping for you.
 */
export class SpekoSTT extends stt.STT {
  label = 'speko.STT';
  readonly #speko: Speko;
  readonly #intent: Intent;
  readonly #constraints: PipelineConstraints | undefined;

  constructor(options: SpekoSTTOptions) {
    super({ streaming: false, interimResults: false });
    validateIntent(options.intent);
    this.#speko = options.speko;
    this.#intent = options.intent;
    this.#constraints = options.constraints;
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
        vertical: this.#intent.vertical,
        ...(this.#intent.optimizeFor !== undefined && {
          optimizeFor: this.#intent.optimizeFor,
        }),
        contentType: 'audio/wav',
        ...(this.#constraints !== undefined && { constraints: this.#constraints }),
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
      'SpekoSTT does not support native streaming (Speko proxy is buffered). ' +
        'Wrap this instance with `new stt.StreamAdapter(spekoStt, vad)` from ' +
        '@livekit/agents, or pass it through `createSpekoComponents()` which ' +
        'returns a ready-to-use StreamAdapter-wrapped STT.',
    );
  }
}
