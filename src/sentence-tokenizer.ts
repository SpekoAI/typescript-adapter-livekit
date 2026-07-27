import { tokenize } from '@livekit/agents';

/**
 * Sentence tokenizer used to chunk LLM output for streaming TTS
 * (see {@link createSpekoComponents}).
 *
 * `retainFormat: true` is load-bearing for the TRANSCRIPT, not the audio
 * (SPE-141). The agent transcript is assembled by concatenating these sentence
 * tokens, and LiveKit's basic tokenizer with the default `retainFormat: false`
 * `.trim()`s every token - so consecutive sentences render glued together
 * ("...rabotaet.Chem mogu...", seen on a live Russian session) because the
 * separating whitespace is gone. Keeping
 * the format preserves the inter-sentence space so the transcript reads normally.
 * Audio is unaffected either way: providers ignore a leading space on the chunk.
 */
export function createDefaultSentenceTokenizer(): tokenize.SentenceTokenizer {
  return new tokenize.basic.SentenceTokenizer({ retainFormat: true });
}
