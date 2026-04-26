import type { OptimizeFor, RoutingIntent } from '@spekoai/sdk';

/**
 * Routing hint passed to every Speko proxy call the adapter makes. Mirrors
 * `@spekoai/sdk`'s `RoutingIntent` so that callers can pass a value they got
 * from the SDK directly without a type detour.
 */
export type Intent = RoutingIntent;

export type { OptimizeFor };

const OPTIMIZE_FOR: ReadonlySet<OptimizeFor> = new Set([
  'balanced',
  'accuracy',
  'latency',
  'cost',
]);

/**
 * Validate an {@link Intent} at construction time so that a broken routing
 * hint throws when the adapter is created, not deep inside the first STT call.
 */
export function validateIntent(intent: Intent): void {
  if (!intent.language || typeof intent.language !== 'string') {
    throw new Error('SpekoAdapter: intent.language is required (BCP-47 tag)');
  }
  if (intent.optimizeFor !== undefined && !OPTIMIZE_FOR.has(intent.optimizeFor)) {
    throw new Error(
      `SpekoAdapter: unknown optimizeFor "${intent.optimizeFor}". ` +
        `Expected one of: ${[...OPTIMIZE_FOR].join(', ')}.`,
    );
  }
}
