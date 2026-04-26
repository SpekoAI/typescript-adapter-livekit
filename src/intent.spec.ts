import { describe, expect, it } from 'vitest';

import { validateIntent } from './intent.js';

describe('validateIntent', () => {
  it('accepts a valid intent', () => {
    expect(() =>
      validateIntent({ language: 'es-MX', optimizeFor: 'accuracy' }),
    ).not.toThrow();
  });

  it('accepts an intent without optimizeFor', () => {
    expect(() => validateIntent({ language: 'en' })).not.toThrow();
  });

  it('throws on missing language', () => {
    expect(() =>
      validateIntent({ language: '' as unknown as string }),
    ).toThrow(/language/);
  });

  it('throws on unknown optimizeFor', () => {
    expect(() =>
      validateIntent({
        language: 'en',
        optimizeFor: 'speed' as unknown as 'latency',
      }),
    ).toThrow(/optimizeFor/);
  });
});
