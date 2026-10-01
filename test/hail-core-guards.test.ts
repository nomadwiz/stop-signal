// Guards on hail-core that the compiler cannot enforce: ADR-002 rule 1 (no clock reads,
// sleeps or timeouts) and ADR-015 (no runtime dependencies).
import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

async function errorsIn(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.errorCount;
}

describe('hail-core reads no clock', () => {
  const banned = [
    'Date.now();',
    'new Date();',
    'Date();',
    'setTimeout(() => {}, 1);',
    'setInterval(() => {}, 1);',
    'performance.now();',
  ];

  it.each(banned)('rejects %s inside hail-core', async (code) => {
    expect(await errorsIn(code, 'packages/hail-core/src/x.ts')).toBeGreaterThan(0);
  });

  it.each(banned)('allows %s outside hail-core', async (code) => {
    expect(await errorsIn(code, 'packages/hail-service/src/x.ts')).toBe(0);
  });

  it('allows a Date built from a known instant', async () => {
    expect(await errorsIn('new Date(0);', 'packages/hail-core/src/x.ts')).toBe(0);
  });
});

describe('hail-core depends on nothing at runtime', () => {
  it('declares no dependencies', async () => {
    const manifest = JSON.parse(await readFile('packages/hail-core/package.json', 'utf8'));
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
