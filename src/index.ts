/**
 * @speko/adapter-livekit — LiveKit adapter for Speko.
 *
 * This package is scaffolded as a placeholder. The real implementation will
 * provide a LiveKit agent worker that delegates STT, LLM, and TTS calls to
 * the Speko proxy (`@speko/sdk`) so the chosen provider is auto-routed per
 * call. Track progress at https://github.com/SpekoAI/platform.
 */
export const ADAPTER_STATUS = 'scaffolded' as const;

export type AdapterStatus = typeof ADAPTER_STATUS;
