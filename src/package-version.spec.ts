import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
let fixtureRoot: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'speko-adapter-version-'));
  cpSync(join(packageRoot, 'src'), join(fixtureRoot, 'src'), { recursive: true });
  cpSync(join(packageRoot, 'scripts'), join(fixtureRoot, 'scripts'), { recursive: true });
  cpSync(join(packageRoot, 'tsconfig.publish.json'), join(fixtureRoot, 'tsconfig.publish.json'));
  writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify(manifest));
  symlinkSync(join(packageRoot, 'node_modules'), join(fixtureRoot, 'node_modules'), 'junction');
  execFileSync(
    process.execPath,
    [require.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.publish.json'],
    {
      cwd: fixtureRoot,
      timeout: 30_000,
      stdio: 'inherit',
    },
  );
}, 35_000);

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('emitted adapter request version', () => {
  it('preserves the native factory arguments with present, blank, and absent sessions', () => {
    const output = execFileSync(process.execPath, ['scripts/check-package-version.mjs'], {
      cwd: fixtureRoot,
      timeout: 10_000,
      encoding: 'utf8',
    });
    expect(output).toContain(`${manifest.name}/${manifest.version}`);
  });

  it('blocks publication when metadata changes without the emitted native marker', () => {
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      JSON.stringify({ ...manifest, version: '0.0.0-version-probe' }),
    );
    try {
      expect(() =>
        execFileSync(process.execPath, ['scripts/check-package-version.mjs'], {
          cwd: fixtureRoot,
          timeout: 10_000,
          stdio: 'pipe',
        }),
      ).toThrow(
        'Adapter factory headers must match package.json and preserve auth/session arguments',
      );
    } finally {
      writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify(manifest));
    }
  });
});
