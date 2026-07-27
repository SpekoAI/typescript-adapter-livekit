import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    expect(manifest['version']).toBe('0.1.4');
  });
});

const files = manifest['files'] as string[];

describe('published tarball contents', () => {
  it('ships the LICENSE the manifest claims', () => {
    // 0.1.3 declared `"license": "MIT"` and listed LICENSE in `files`, but the
    // file did not exist, so the published tarball carried no licence text at
    // all. `files` silently skips entries that are not on disk.
    expect(files).toContain('LICENSE');
    expect(existsSync(join(packageRoot, 'LICENSE'))).toBe(true);
    expect(readFileSync(join(packageRoot, 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
    expect(manifest['license']).toBe('MIT');
  });

  it('covers every path its export map points at', () => {
    // 0.1.3 exposed `"@spekoai/source": "./src/index.ts"` while `files` shipped
    // `dist` only, so the condition resolved to a path that was not in the
    // tarball (and every dist/*.d.ts.map pointed into the same missing tree).
    //
    // `files` coverage is what this asserts. On-disk existence is only checked
    // for paths the build does not produce, so the suite does not depend on
    // whether `build` has run first.
    const root = (manifest['exports'] as Record<string, Record<string, string> | string>)[
      '.'
    ] as Record<string, string>;
    for (const target of Object.values(root)) {
      const relative = target.replace(/^\.\//, '');
      const topLevel = relative.split('/')[0] as string;
      expect(files, `${target} is not covered by "files"`).toContain(topLevel);
      if (topLevel === 'dist') continue;
      expect(existsSync(join(packageRoot, relative)), `${target} is missing`).toBe(true);
    }
  });

  it('keeps specs out of the shipped source tree', () => {
    expect(files).toContain('src');
    expect(files).toContain('!src/**/*.spec.ts');
  });
});

const shippedSources = readdirSync(join(packageRoot, 'src'))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
  .map((name) => join('src', name));

describe('shipped text is plain ASCII', () => {
  // Comments in these files are emitted verbatim into dist/*.js and dist/*.d.ts,
  // so an em dash here becomes an em dash in a consumer's IDE tooltip - and, in
  // the 0.1.3 `createSpekoComponents` throw, in their terminal.
  it.each([
    ...shippedSources,
    'README.md',
    'CHANGELOG.md',
    'package.json',
  ])('%s', (relativePath) => {
    const text = readFileSync(join(packageRoot, relativePath), 'utf8');
    const offenders = [...text.matchAll(/[^\p{ASCII}]/gu)].map((match) => {
      const line = text.slice(0, match.index).split('\n').length;
      return `${relativePath}:${line} ${JSON.stringify(match[0])}`;
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * Every `createSpekoComponents({ ... })` call we publish - README plus the
 * JSDoc `@example` that lands in `dist/components.d.ts` - has to be a call that
 * actually runs. The 0.1.3 README and JSDoc both omitted `sttBaseUrl`/`sttApiKey`
 * while `sttStreaming` defaults to `true`, so the first snippet a developer
 * copied threw on the first call.
 */
describe('documented createSpekoComponents examples are runnable', () => {
  const documents = [
    ['README.md', readFileSync(join(packageRoot, 'README.md'), 'utf8')],
    ['src/components.ts', readFileSync(join(packageRoot, 'src', 'components.ts'), 'utf8')],
  ] as const;

  it.each(documents)('%s passes the streaming credentials or opts out', (_name, text) => {
    const calls = [...text.matchAll(/createSpekoComponents\(\{/g)].map((match) =>
      balancedCall(text, (match.index ?? 0) + 'createSpekoComponents('.length),
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const streamingOff = /sttStreaming:\s*false/.test(call);
      const credentialled = /sttBaseUrl:/.test(call) && /sttApiKey:/.test(call);
      expect(streamingOff || credentialled, `unrunnable example:\n${call}`).toBe(true);
    }
  });
});

/** Slice out `{ ... }` starting at `openIndex`, matching braces. */
function balancedCall(text: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  throw new Error('unbalanced createSpekoComponents call in documentation');
}
