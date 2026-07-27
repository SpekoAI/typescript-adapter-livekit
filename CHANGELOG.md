# Changelog

## 0.1.4

Documentation and packaging fixes. No runtime behavior changes.

### Fixes

- **The headline example now runs.** Both the README's `## Usage` snippet and the
  `createSpekoComponents` JSDoc `@example` called it without `sttBaseUrl` /
  `sttApiKey`. `sttStreaming` defaults to `true`, which requires both, so the
  first thing a developer copied threw on the first call - and the same broken
  form was in the shipped `.d.ts`, so every IDE tooltip taught it. Both now pass
  the two options, and a test asserts that every published
  `createSpekoComponents({...})` snippet either supplies them or sets
  `sttStreaming: false`.
- **Removed a documented API that does not exist.** The `ttsOptions` JSDoc told
  callers to "update it later via `components.ttsProvider.setInstructions(...)`".
  There is no `ttsProvider` on the returned bundle and no `setInstructions` on
  any export; the `SpekoTTS` instance is not even reachable through
  `components.tts` (a `tts.StreamAdapter` holds it privately). The doc now says
  what actually works: build a new `SpekoTTS` and hand a new `voice.Agent` to
  `session.updateAgent()`.
- **The LICENSE is now in the tarball.** `package.json` declared `"license":
  "MIT"` and listed `LICENSE` in `files`, but the file did not exist, so npm
  silently shipped no licence text. Added the same MIT text `@spekoai/sdk`
  carries.
- **`exports["."]["@spekoai/source"]` resolves.** It pointed at `./src/index.ts`
  while `files` shipped `dist` only. `src` (minus specs) is now published, which
  also makes the ten `dist/*.d.ts.map` files resolve - go-to-definition into the
  package previously landed on missing files.
- **README "Limitations (v1)" described the wrong STT default.** It said STT
  upload is VAD/utterance-bounded; that has been `sttStreaming: false` since the
  native WebSocket path became the default. Renamed to "Behavior and limits (v1)"
  and corrected.
- **README used `voice: 'sonic-english'`,** a Cartesia model name, not a voice
  id. Passing it fails on every routed provider (`ALL_PROVIDERS_FAILED` after 8
  attempts). Replaced with a real voice id and a pointer to `GET /v1/voices`.
- **The `createSpekoComponents` throw message is plain ASCII** and now names the
  fix. Every shipped source file is ASCII, so no em dash reaches a consumer's
  terminal or IDE tooltip; a test enforces it.

### Documentation

- `SpekoSTTOptions.keywords` now documents the gateway's 200-term cap and what
  exceeding it looks like (batch: `400`; streaming: WS close 4400 surfaced as a
  permanent `stt_error`). The cap is enforced server-side; the adapter does not
  truncate.
- The README's "use the classes directly" snippet shows the streaming `SpekoSTT`
  form alongside the batch one, since `createSpekoComponents` defaults to
  streaming but direct construction does not.

### Internal

- Removed `createTestFrame` from `audio.ts` - never exported from the package
  root, never called by anything, including the spec files its doc comment
  claimed it existed for.
- `SpekoLLM` names the SDK's `CompleteResult` instead of restating its fields,
  derives the completion text length once, and drops a single-use `extractText`
  wrapper and a dead `else` branch.
- `SpekoSpeechStream` no longer keeps a second copy of `sessionId` alongside its
  options, reuses the existing `unrefTimer` helper in `close()`, and drops a
  condition in the reconnect loop's catch that could never be true.

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
