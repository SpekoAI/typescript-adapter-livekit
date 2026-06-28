import { APIConnectionError, APIError, APIStatusError } from '@livekit/agents';
import { SpekoApiError } from '@spekoai/sdk';

/**
 * True for an `AbortSignal`-driven cancellation rather than a fault. The
 * framework aborts an in-flight STT/LLM/TTS request the instant it commits a
 * new user turn (a normal barge-in). That cancellation surfaces as an
 * `AbortError` (or a generic error while `abortSignal.aborted` is set) and MUST
 * NOT be treated as a provider failure — otherwise every interrupted reply
 * emits a spurious `recoverable:false` error and, after a few back-to-back
 * barge-ins, closes the live call.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

// Adapter/gateway fault codes that a retry (or router failover) can recover
// from — a transient blip, not a permanent misconfiguration.
const RETRYABLE_FAULT_CODES = new Set([
  'STREAM_ENDED', // SSE/WS ended without a terminal `done` — re-issue the turn.
  'EMPTY_COMPLETION', // router returned blank — re-roll (may pick another provider).
  'EMPTY_BODY', // empty HTTP body from the gateway.
  'EMPTY_AUDIO', // TTS returned zero frames — provider glitch.
  'RATE_LIMITED', // 429 — back off and retry.
  'SERVER_ERROR', // 5xx upstream.
  'UPSTREAM_ERROR', // router-reported upstream provider fault.
  'WS_ERROR', // transient socket fault.
]);

// Deterministic faults that retrying cannot fix — fail fast and deliberately.
const PERMANENT_FAULT_CODES = new Set([
  'INVALID_CONTEXT', // ChatContext produced no convertible messages — a code bug.
  'SAMPLE_RATE_MISMATCH', // provider rate != configured rate — a routing misconfig.
  'UNSUPPORTED_CONTENT_TYPE', // non-PCM/WAV audio — a routing misconfig.
  'UNSUPPORTED_CHANNELS', // stereo where mono is required.
  'AUTH_ERROR', // 401/403 — a credential problem.
  'UNAUTHORIZED',
  'INVALID_REQUEST', // 400-class client error.
]);

/**
 * Translate ANY provider / SDK / network error into the framework's `APIError`
 * so the STT/LLM/TTS retry loop engages.
 *
 * Why this boundary exists: the framework only retries an error that is
 * `instanceof APIError` AND has `retryable:true` (see `@livekit/agents`
 * `{stt,llm,tts}.ts` run loops). A plain `Error` falls into the `else` branch
 * and is reported to the `AgentSession` as `recoverable:false` with ZERO
 * retries — so a single transient blip (a 429, a 5xx, a dropped connection, an
 * empty body) needlessly closes a live phone call. STT is worse still: the
 * session's `_onError` has no `stt_error` budget, so the first one closes the
 * call instantly. Every Speko adapter historically threw plain `Error` /
 * `SpekoAdapterError` / `SpekoApiError`, leaving the framework's `maxRetry`
 * (default 3) as dead code. Mapping faults here re-arms it and makes
 * `recoverable:false` mean "genuinely unrecoverable".
 *
 * Classification:
 *  - already an `APIError` → returned unchanged (preserves an upstream-chosen
 *    `retryable`, including an intentionally non-retryable one).
 *  - SDK `SpekoApiError` (carries an HTTP status) → `APIStatusError`, which
 *    auto-classifies 408/429/5xx (and any non-4xx) as retryable and other 4xx
 *    (401 auth, 400/404/422 client errors) as permanent.
 *  - a coded fault (our `SpekoAdapterError`, or a gateway error frame) →
 *    retryable / permanent per the code tables above.
 *  - anything else (a `fetch` `TypeError`, `ECONNRESET`, an unknown throw) →
 *    a retryable `APIConnectionError`. Defaulting the unknown case to retryable
 *    costs at most a few retries for a genuine bug but saves every transient
 *    network fault from killing the call.
 */
export function toFrameworkApiError(err: unknown): APIError {
  if (err instanceof APIError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof SpekoApiError) {
    // status -> retryable is decided inside APIStatusError (408/429/5xx + non-4xx
    // retryable; other 4xx permanent), which is exactly the policy we want.
    return new APIStatusError({ message, options: { statusCode: err.status } });
  }

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: unknown }).code
      : undefined;
  if (typeof code === 'string') {
    if (PERMANENT_FAULT_CODES.has(code)) return new APIError(message, { retryable: false });
    if (RETRYABLE_FAULT_CODES.has(code)) return new APIError(message, { retryable: true });
  }

  return new APIConnectionError({ message, options: { retryable: true } });
}
