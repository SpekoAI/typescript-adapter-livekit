import { APIConnectionError, APIError, APIStatusError } from '@livekit/agents';
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
    expect(out.message).toBe('upstream 503');
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
});
