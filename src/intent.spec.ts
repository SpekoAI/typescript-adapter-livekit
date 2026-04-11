import { describe, expect, it } from 'vitest';

import { validateIntent } from './intent.js';

describe('validateIntent', () => {
  it('accepts a valid intent', () => {
    expect(() =>
      validateIntent({ language: 'es-MX', vertical: 'healthcare', optimizeFor: 'accuracy' }),
    ).not.toThrow();
  });

  it('accepts an intent without optimizeFor', () => {
    expect(() => validateIntent({ language: 'en', vertical: 'general' })).not.toThrow();
  });

  it('throws on missing language', () => {
    expect(() =>
      validateIntent({ language: '' as unknown as string, vertical: 'general' }),
    ).toThrow(/language/);
  });

  it('throws on unknown vertical', () => {
    expect(() =>
      validateIntent({
        language: 'en',
        vertical: 'medical' as unknown as 'healthcare',
      }),
    ).toThrow(/vertical/);
  });

  it('throws on unknown optimizeFor', () => {
    expect(() =>
      validateIntent({
        language: 'en',
        vertical: 'general',
        optimizeFor: 'speed' as unknown as 'latency',
      }),
    ).toThrow(/optimizeFor/);
  });
});
