import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const manifest = readJson(join(packageRoot, 'package.json'));
const peerDependencies = manifest['peerDependencies'] as Record<string, string>;

/**
 * The SDK peer range as it will be PUBLISHED. In the monorepo the value carries
 * pnpm's `workspace:` prefix (which keeps the local `packages/sdk` link);
 * `pnpm pack` strips the prefix and publishes the range that follows it.
 */
const publishedSdkRange = peerDependencies['@spekoai/sdk']?.replace(/^workspace:/, '') ?? '';

/**
 * Minimal `>=A <B` evaluator. Hand-rolled rather than pulled from `semver`
 * because this package publishes with zero runtime dependencies beyond tslib and
 * the range it needs to check has exactly this one shape.
 */
function satisfiesLowerUpper(version: string, range: string): boolean {
  const match = range.match(/^>=(\d+\.\d+\.\d+)\s+<(\d+\.\d+\.\d+)$/);
  if (!match?.[1] || !match[2]) throw new Error(`unsupported range shape: ${range}`);
  const parse = (value: string) => value.split('.').map(Number);
  const compare = (a: number[], b: number[]) =>
    (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
  const target = parse(version);
  return compare(target, parse(match[1])) >= 0 && compare(target, parse(match[2])) < 0;
}

describe('@spekoai/sdk peer range', () => {
  it("keeps pnpm's workspace link so the monorepo builds against packages/sdk", () => {
    // A bare semver range here makes pnpm resolve the SDK from the REGISTRY
    // instead of linking the workspace copy, which silently builds the adapter
    // against a published SDK.
    expect(peerDependencies['@spekoai/sdk']).toMatch(/^workspace:/);
  });

  it('is a minor-spanning range, not a caret pin', () => {
    // The published 0.1.2 shipped `^0.4.3`, i.e. `>=0.4.3 <0.5.0`. That excluded
    // the then-current SDK, so every documented install printed ERESOLVE and
    // `npm ls` exited non-zero.
    expect(publishedSdkRange).toBe('>=0.4.3 <0.6.0');
    expect(publishedSdkRange.startsWith('^')).toBe(false);
  });

  it('admits the SDK version this monorepo actually builds against', () => {
    // The regression guard that matters: bumping packages/sdk past the range's
    // ceiling without widening it here re-breaks every install.
    const sdkVersion = readJson(join(packageRoot, '..', 'sdk', 'package.json'))[
      'version'
    ] as string;
    expect(satisfiesLowerUpper(sdkVersion, publishedSdkRange)).toBe(true);
  });

  it.each(['0.4.3', '0.4.9', '0.5.0', '0.5.1'])('admits SDK %s', (version) => {
    expect(satisfiesLowerUpper(version, publishedSdkRange)).toBe(true);
  });

  it.each(['0.4.2', '0.6.0', '1.0.0'])('excludes SDK %s', (version) => {
    expect(satisfiesLowerUpper(version, publishedSdkRange)).toBe(false);
  });

  it('publishes the version this changelog entry describes', () => {
    expect(manifest['version']).toBe('0.1.3');
  });
});
