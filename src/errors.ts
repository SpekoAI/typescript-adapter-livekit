import { APIConnectionError, APIError, APIStatusError, APITimeoutError } from '@livekit/agents';

/**
 * A coded adapter/gateway fault. The `code` is what {@link toFrameworkApiError}
 * classifies on, so every throw on a data path (STT recognize, LLM complete,
 * TTS synthesize/decode) should carry one rather than being a bare `Error` — a
 * bare `Error` can only be guessed at, and the guess is "retryable".
 *
 * Lives here rather than in `llm.ts` so the audio/TTS paths can raise coded
 * faults without importing the LLM module. `llm.ts` re-exports it and
 * `index.ts` still exports it, so the public surface is unchanged.
 */
export class SpekoAdapterError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SpekoAdapterError';
    this.code = code;
  }
}

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
  'MALFORMED_AUDIO', // truncated/garbled audio payload — a retry can fail over.
  'RATE_LIMITED', // 429 — back off and retry.
  'SERVER_ERROR', // 5xx upstream.
  'UPSTREAM_ERROR', // router-reported upstream provider fault.
  'WS_ERROR', // transient socket fault.
]);

// Deterministic faults that retrying cannot fix — fail fast and deliberately.
const PERMANENT_FAULT_CODES = new Set([
  'INVALID_CONTEXT', // ChatContext produced no convertible messages — a code bug.
  // Gateway-reported rate conflict. The adapter no longer raises this itself:
  // it resamples a differing response rate instead (see tts.ts).
  'SAMPLE_RATE_MISMATCH',
  'UNSUPPORTED_CONTENT_TYPE', // non-PCM/WAV audio — a routing misconfig.
  'UNSUPPORTED_AUDIO_FORMAT', // WAV that is not 16-bit PCM — a provider misconfig.
  'UNSUPPORTED_CHANNELS', // stereo where mono is required.
  'AUTH_ERROR', // 401/403 — a credential problem.
  'UNAUTHORIZED',
  'INVALID_REQUEST', // 400-class client error.
]);

// `error.name` values that mean "the request ran out of time". `TimeoutError` is
// what `AbortSignal.timeout()` rejects with; the rest are undici's own timeout
// classes (undici backs Node's global `fetch`, which the SDK uses).
const TIMEOUT_ERROR_NAMES = new Set([
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);

// `error.code` values that mean the same thing.
const TIMEOUT_FAULT_CODES = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'TIMEOUT',
  'REQUEST_TIMEOUT',
  'GATEWAY_TIMEOUT',
]);

// `fetch` hides the real fault one level down: a connect timeout or a reset
// socket arrives as `TypeError: fetch failed` whose `cause` carries the code.
// Walk a few links so classification can see it, bounded (and cycle-guarded) so
// a self-referencing `cause` chain cannot spin.
const MAX_CAUSE_DEPTH = 4;

function unwrapCauses(err: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = err;
  while (current !== null && current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    if (typeof current !== 'object' || !('cause' in current)) break;
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** First `code` found on the error or anywhere down its `cause` chain. */
function faultCode(chain: readonly unknown[]): string | undefined {
  for (const link of chain) {
    const code = readString(link, 'code');
    if (code !== undefined) return code;
  }
  return undefined;
}

/**
 * HTTP status carried by the error, read structurally rather than through
 * `instanceof SpekoApiError`. A widened peer range (or simply two SDK copies in
 * one tree) can produce an SDK error that fails `instanceof` while still
 * carrying a perfectly good `status`; losing it there would turn a fail-fast
 * 401 into three pointless retries against a bad credential.
 */
function httpStatus(chain: readonly unknown[]): number | undefined {
  for (const link of chain) {
    if (typeof link !== 'object' || link === null) continue;
    for (const key of ['status', 'statusCode'] as const) {
      if (!(key in link)) continue;
      const raw = (link as Record<string, unknown>)[key];
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599) {
        return raw;
      }
    }
  }
  return undefined;
}

function isTimeout(chain: readonly unknown[]): boolean {
  for (const link of chain) {
    const name = readString(link, 'name');
    if (name !== undefined && TIMEOUT_ERROR_NAMES.has(name)) return true;
    const code = readString(link, 'code');
    if (code !== undefined && TIMEOUT_FAULT_CODES.has(code)) return true;
  }
  return false;
}

/**
 * Structural `APIError` detection, used only to re-wrap a foreign copy. With
 * `@livekit/agents` as a peer dependency a tree can end up with two copies, and
 * an error thrown by copy A fails `instanceof` against copy B — which is exactly
 * the check the framework's retry loop performs. Re-wrapping into the copy THIS
 * module imported (the same one the caller's framework uses) keeps the retry
 * decision instead of silently losing it.
 */
function apiErrorLike(err: unknown): { message: string; retryable: boolean } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = readString(err, 'name');
  if (name === undefined || !name.startsWith('API')) return undefined;
  if (!('retryable' in err)) return undefined;
  const retryable = (err as { retryable?: unknown }).retryable;
  if (typeof retryable !== 'boolean') return undefined;
  return { message: err instanceof Error ? err.message : String(err), retryable };
}

/**
 * Stamp the gateway's fault code (and HTTP status) onto the message. The
 * framework logs `error.message` in the two places that matter most — the retry
 * warning and the `recoverable:false` session error — so a message without the
 * code forces a log dive to learn whether a dead turn was a 429, a blank
 * completion or an expired key.
 */
function withFaultContext(message: string, code: string | undefined, status?: number): string {
  const parts: string[] = [];
  if (code !== undefined && code !== 'UNKNOWN') parts.push(`code=${code}`);
  if (status !== undefined) parts.push(`status=${status}`);
  if (parts.length === 0) return message;
  // Never double-stamp: this error may already have been through here.
  if (parts.some((part) => message.includes(part))) return message;
  return `${message} (${parts.join(' ')})`;
}

function faultBody(code: string | undefined, status: number | undefined): object | null {
  if (code === undefined && status === undefined) return null;
  return {
    ...(code !== undefined && { code }),
    ...(status !== undefined && { status }),
  };
}

/**
 * Translate ANY provider / SDK / network error into the framework's `APIError`
 * so the STT/LLM/TTS retry loop engages.
 *
 * Why this boundary exists: the framework only retries an error that is
 * `instanceof APIError` AND has `retryable:true` — every run loop in
 * `@livekit/agents` (`stt/stt.js`, `llm/llm.js`, `tts/tts.js`) reads
 * `if (error instanceof APIError) { ...retry... } else { emitError({recoverable:false}); throw }`.
 * A plain `Error` takes the `else` branch and is reported to the `AgentSession`
 * as `recoverable:false` with ZERO retries, so a single transient blip (a 429, a
 * 5xx, a dropped socket, an empty body) needlessly closes a live phone call and
 * `DEFAULT_API_CONNECT_OPTIONS.maxRetry` (3) is dead code. STT is worse still:
 * the session's `_onError` has no `stt_error` budget, so the first one closes
 * the call instantly.
 *
 * Classification, in order:
 *  1. already an `APIError` from our copy of the framework → returned unchanged
 *     (preserves an upstream-chosen `retryable`, including a deliberate `false`).
 *  2. an `APIError` from a DIFFERENT copy of `@livekit/agents` → re-wrapped into
 *     ours, preserving `retryable`, so the caller's `instanceof` still matches.
 *  3. a timeout (`AbortSignal.timeout`, undici `UND_ERR_*_TIMEOUT`, `ETIMEDOUT`,
 *     including when buried in a `fetch` error's `cause`) → `APITimeoutError`,
 *     which is retryable.
 *  4. a known-permanent fault code → non-retryable, so the framework fails fast
 *     rather than burning `maxRetry` attempts on a deterministic misconfig.
 *  5. an HTTP status → `APIStatusError`, whose own classification retries
 *     408/429/5xx (and any non-4xx) and fails fast on 400/401/404/422.
 *  6. a known-retryable fault code → retryable `APIError`.
 *  7. anything else (a `fetch` `TypeError`, `ECONNRESET`, an unknown throw) → a
 *     retryable `APIConnectionError`. Defaulting the unknown case to retryable
 *     costs at most a few retries for a genuine bug but saves every transient
 *     network fault from killing the call.
 */
export function toFrameworkApiError(err: unknown): APIError {
  if (err instanceof APIError) return err;

  const foreign = apiErrorLike(err);
  if (foreign !== undefined) {
    return new APIError(foreign.message, { retryable: foreign.retryable });
  }

  const chain = unwrapCauses(err);
  const code = faultCode(chain);
  const status = httpStatus(chain);
  const message = withFaultContext(err instanceof Error ? err.message : String(err), code, status);
  const body = faultBody(code, status);

  if (isTimeout(chain)) {
    return new APITimeoutError({ message, options: { retryable: true } });
  }

  if (code !== undefined && PERMANENT_FAULT_CODES.has(code)) {
    // Keep the status-bearing shape when there is one (an auth failure should
    // still read as an APIStatusError) but pin retryable ourselves —
    // APIStatusError only ever forces `false`, never `true`, so this holds.
    return status !== undefined
      ? new APIStatusError({ message, options: { statusCode: status, retryable: false, body } })
      : new APIError(message, { retryable: false, body });
  }

  if (status !== undefined) {
    // status -> retryable is decided inside APIStatusError (408/429/5xx + non-4xx
    // retryable; other 4xx permanent), which is exactly the policy we want.
    return new APIStatusError({ message, options: { statusCode: status, body } });
  }

  if (code !== undefined && RETRYABLE_FAULT_CODES.has(code)) {
    return new APIError(message, { retryable: true, body });
  }

  return new APIConnectionError({ message, options: { retryable: true } });
}
