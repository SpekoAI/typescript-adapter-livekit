import { APIConnectionError, APIError, APIStatusError, APITimeoutError } from '@livekit/agents';
import { SpekoApiError, SpekoAuthError, SpekoRateLimitError } from '@spekoai/sdk';
import { describe, expect, it } from 'vitest';

import { isAbortError, toFrameworkApiError } from './errors.js';
import { SpekoAdapterError } from './llm.js';

describe('isAbortError', () => {
  it('is true for a DOMException AbortError', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('is true for any object whose name is AbortError', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
    const e = new Error('x');
    e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
  });

  it('is false for a normal error, a string, and null', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('toFrameworkApiError', () => {
  it('always returns an APIError instance', () => {
    expect(toFrameworkApiError(new Error('x'))).toBeInstanceOf(APIError);
    expect(toFrameworkApiError('plain string')).toBeInstanceOf(APIError);
    expect(toFrameworkApiError(new SpekoApiError('x', 500, 'SERVER_ERROR'))).toBeInstanceOf(
      APIError,
    );
  });

  it('passes an existing APIError through unchanged (preserving a non-retryable flag)', () => {
    const permanent = new APIError('already shaped', { retryable: false });
    expect(toFrameworkApiError(permanent)).toBe(permanent);
    expect(toFrameworkApiError(permanent).retryable).toBe(false);
  });

  it('maps a 5xx SpekoApiError to a retryable APIStatusError', () => {
    const out = toFrameworkApiError(new SpekoApiError('upstream 503', 503, 'SERVER_ERROR'));
    expect(out).toBeInstanceOf(APIStatusError);
    expect(out.retryable).toBe(true);
    expect((out as APIStatusError).statusCode).toBe(503);
    // The gateway's code + status ride on the message: the framework logs
    // `error.message` on both the retry warning and the final session error.
    expect(out.message).toContain('upstream 503');
    expect(out.message).toContain('code=SERVER_ERROR');
    expect(out.message).toContain('status=503');
  });

  it('a single transient 503 stays retryable, so the framework retry loop engages', () => {
    // The regression this guards: a bare Error (or any non-APIError) takes the
    // `else` branch of every @livekit/agents run loop, which emits
    // recoverable:false and re-throws WITHOUT consuming maxRetry. One blip then
    // kills the turn (and on STT, the call).
    const out = toFrameworkApiError(new SpekoApiError('service unavailable', 503, 'SERVER_ERROR'));
    expect(out).toBeInstanceOf(APIError);
    expect(out.retryable).toBe(true);
  });

  it('does not double-stamp the fault context when re-wrapping is attempted twice', () => {
    const once = toFrameworkApiError(new SpekoApiError('boom', 503, 'SERVER_ERROR'));
    // A already-APIError passes through untouched, so the message must not grow.
    expect(toFrameworkApiError(once).message).toBe(once.message);
  });

  it('maps a 429 rate-limit to a retryable error', () => {
    const out = toFrameworkApiError(new SpekoRateLimitError('slow down', 2));
    expect(out.retryable).toBe(true);
  });

  it('maps a 401 auth error to a NON-retryable error', () => {
    const out = toFrameworkApiError(new SpekoAuthError());
    expect(out).toBeInstanceOf(APIStatusError);
    expect(out.retryable).toBe(false);
  });

  it('maps a 400 client error to a NON-retryable error', () => {
    const out = toFrameworkApiError(new SpekoApiError('bad request', 400, 'INVALID_REQUEST'));
    expect(out.retryable).toBe(false);
  });

  it('treats a 200-status stream-ended SpekoApiError as retryable', () => {
    const out = toFrameworkApiError(new SpekoApiError('stream ended', 200, 'STREAM_ENDED'));
    expect(out.retryable).toBe(true);
  });

  it('maps STREAM_ENDED / EMPTY_COMPLETION adapter codes to retryable', () => {
    expect(toFrameworkApiError(new SpekoAdapterError('ended', 'STREAM_ENDED')).retryable).toBe(
      true,
    );
    expect(toFrameworkApiError(new SpekoAdapterError('blank', 'EMPTY_COMPLETION')).retryable).toBe(
      true,
    );
  });

  it('maps INVALID_CONTEXT to NON-retryable (a deterministic code bug)', () => {
    expect(
      toFrameworkApiError(new SpekoAdapterError('no messages', 'INVALID_CONTEXT')).retryable,
    ).toBe(false);
  });

  it('defaults an unknown error / network fault to a retryable APIConnectionError', () => {
    const fromTypeError = toFrameworkApiError(new TypeError('fetch failed'));
    expect(fromTypeError).toBeInstanceOf(APIConnectionError);
    expect(fromTypeError.retryable).toBe(true);

    const fromString = toFrameworkApiError('ECONNRESET');
    expect(fromString).toBeInstanceOf(APIConnectionError);
    expect(fromString.retryable).toBe(true);
    expect(fromString.message).toBe('ECONNRESET');
  });

  it('maps an AbortSignal.timeout rejection to a retryable APITimeoutError', () => {
    const out = toFrameworkApiError(new DOMException('The operation timed out', 'TimeoutError'));
    expect(out).toBeInstanceOf(APITimeoutError);
    expect(out).toBeInstanceOf(APIConnectionError);
    expect(out.retryable).toBe(true);
  });

  it("maps an undici timeout buried in a fetch error's cause to APITimeoutError", () => {
    // What a real gateway connect timeout looks like on Node: the thrown error is
    // a generic `TypeError: fetch failed` and the diagnosis is one level down.
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      name: 'ConnectTimeoutError',
      code: 'UND_ERR_CONNECT_TIMEOUT',
    });
    const out = toFrameworkApiError(new TypeError('fetch failed', { cause }));
    expect(out).toBeInstanceOf(APITimeoutError);
    expect(out.retryable).toBe(true);
    expect(out.message).toContain('code=UND_ERR_CONNECT_TIMEOUT');
  });

  it('maps a socket ETIMEDOUT to APITimeoutError rather than a plain connection error', () => {
    const out = toFrameworkApiError(
      Object.assign(new Error('connect ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      }),
    );
    expect(out).toBeInstanceOf(APITimeoutError);
    expect(out.retryable).toBe(true);
  });

  it('surfaces a code buried in a cause chain (ECONNRESET under fetch failed)', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const out = toFrameworkApiError(new TypeError('fetch failed', { cause }));
    expect(out).toBeInstanceOf(APIConnectionError);
    expect(out.retryable).toBe(true);
    expect(out.message).toContain('code=ECONNRESET');
  });

  it('reads the HTTP status structurally, so a duplicated SDK copy still fails fast', () => {
    // A widened peer range can put two @spekoai/sdk copies in one tree; the
    // resulting error fails `instanceof SpekoApiError` while still carrying a
    // status. Losing it would turn a dead credential into three retries.
    const foreignSdkError = Object.assign(new Error('invalid api key'), {
      name: 'SpekoApiError',
      status: 401,
      code: 'AUTH_ERROR',
    });
    const out = toFrameworkApiError(foreignSdkError);
    expect(out).toBeInstanceOf(APIStatusError);
    expect((out as APIStatusError).statusCode).toBe(401);
    expect(out.retryable).toBe(false);
  });

  it('re-wraps an APIError from a foreign @livekit/agents copy, preserving retryable', () => {
    // Structurally an APIError but not `instanceof` ours — which is the exact
    // check the framework's retry loop makes, so it must come back as ours.
    const foreign = Object.assign(new Error('upstream blip'), {
      name: 'APIStatusError',
      retryable: true,
    });
    const out = toFrameworkApiError(foreign);
    expect(out).toBeInstanceOf(APIError);
    expect(out.retryable).toBe(true);
    expect(out.message).toBe('upstream blip');

    const foreignPermanent = Object.assign(new Error('bad request'), {
      name: 'APIStatusError',
      retryable: false,
    });
    expect(toFrameworkApiError(foreignPermanent).retryable).toBe(false);
  });

  it('maps a permanent audio-format fault to non-retryable', () => {
    expect(
      toFrameworkApiError(new SpekoAdapterError('mp3', 'UNSUPPORTED_CONTENT_TYPE')).retryable,
    ).toBe(false);
    expect(
      toFrameworkApiError(new SpekoAdapterError('8-bit wav', 'UNSUPPORTED_AUDIO_FORMAT')).retryable,
    ).toBe(false);
    expect(
      toFrameworkApiError(new SpekoAdapterError('stereo', 'UNSUPPORTED_CHANNELS')).retryable,
    ).toBe(false);
  });

  it('maps a truncated audio payload to retryable, so a retry can fail over', () => {
    const out = toFrameworkApiError(new SpekoAdapterError('too small', 'MALFORMED_AUDIO'));
    expect(out).toBeInstanceOf(APIError);
    expect(out.retryable).toBe(true);
  });

  it('lets a permanent code win over a status the framework would call retryable', () => {
    // A 500 that carries a deterministic code is still deterministic; retrying it
    // three times only adds dead air before the same failure.
    const out = toFrameworkApiError(
      new SpekoApiError('router says mp3', 500, 'UNSUPPORTED_CONTENT_TYPE'),
    );
    expect(out).toBeInstanceOf(APIStatusError);
    expect(out.retryable).toBe(false);
  });

  it('survives a self-referencing cause chain', () => {
    const err = new Error('loop') as Error & { cause?: unknown };
    err.cause = err;
    expect(() => toFrameworkApiError(err)).not.toThrow();
    expect(toFrameworkApiError(err)).toBeInstanceOf(APIError);
  });
});
