# Changelog

## 0.1.3

### Fixes

- **Errors now reach LiveKit's retry loop.** Every failure leaving the adapter is
  translated into the framework's own error taxonomy (`APIStatusError`,
  `APIConnectionError`, `APITimeoutError`), because every run loop in
  `@livekit/agents` gates retry on `error instanceof APIError` and treats
  anything else as `recoverable: false` without consuming `maxRetry` (default 3).
  Before this, a single transient 503 killed the turn - and on STT, where the
  `AgentSession` has no error budget, the call. An HTTP status becomes
  `APIStatusError` so LiveKit's own classification applies (retry 408/429/5xx,
  fail fast on 400/401/404/422); transport faults become `APIConnectionError`;
  timeouts become `APITimeoutError`, including when buried in a `fetch` error's
  `cause` chain. The gateway's fault code and HTTP status are stamped onto the
  message, since the framework logs `error.message` on both the retry warning and
  the final session error.
- **Deterministic faults now fail fast.** Audio-decode failures used to be
  guessed as retryable, so an MP3 response or a stereo WAV burned three retries
  before the inevitable close. They now carry codes: `UNSUPPORTED_CONTENT_TYPE`,
  `UNSUPPORTED_AUDIO_FORMAT` and `UNSUPPORTED_CHANNELS` are non-retryable, while
  a truncated payload (`MALFORMED_AUDIO`) stays retryable so a retry can fail
  over to another provider.
- **Routed TTS no longer aborts on a sample-rate mismatch.** `SpekoTTS` declared
  one static 24 kHz rate and threw a non-retryable error whenever the response
  rate differed, on both the WAV and raw-PCM paths. The gateway serves 48 kHz for
  Hume and Gradium and 16 kHz for Amazon Polly, so routing to one of those - or
  failing over onto one mid-call, which is invisible to the caller by design -
  aborted the utterance. The response rate is now read from
  `X-Speko-Audio-Format` (falling back to `Content-Type`) and resampled to the
  rate the instance advertises, so the declared `sampleRate` stays truthful and
  every frame in a turn carries the same rate. Matching rates remain a
  zero-copy pass-through, so the common 24 kHz path is unchanged.
- **Widened the `@spekoai/sdk` peer range** from `^0.4.3` (which resolves to
  `>=0.4.3 <0.5.0`) to `>=0.4.3 <0.6.0`. The old range excluded the current SDK
  0.5.x, so every documented install left the tree formally invalid: npm printed
  ERESOLVE and `npm ls` exited non-zero.

### Additions

- `createSampleRateNormalizer()` and the `SampleRateNormalizer` type are
  exported for callers that pipe Speko audio through their own stages.
- `SpekoAdapterError` now lives in `errors.ts` so the audio and TTS paths can
  raise coded faults without importing the LLM module. It is still exported from
  the package root and from `llm.js`, so no import path changes.
- `decodeSynthesisResult()` takes an optional second argument, the audio-format
  string to branch on (normally the response's `X-Speko-Audio-Format`).

## 0.1.2

- Initial published baseline tracked in this changelog.
