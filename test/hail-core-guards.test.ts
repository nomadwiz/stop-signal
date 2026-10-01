// Guards on hail-core that the compiler cannot enforce: ADR-002 rule 1 (no clock reads,
// sleeps or timeouts) and ADR-015 (no runtime dependencies).
import { readFile } from 'node:fs/promises';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

// Counts only the clock ban's errors, so an unrelated error cannot pass a 'rejects' case.
async function clockErrors(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.message.includes('ADR-002')).length;
}

describe('hail-core reads no clock', () => {
  const banned = [
    'Date.now();',
    'new Date();',
    'Date();',
    'setTimeout(() => {}, 1);',
    'setInterval(() => {}, 1);',
    'performance.now();',
    'process.hrtime();',
    'process.hrtime.bigint();',
    'process.uptime();',
    'globalThis.setTimeout(() => {}, 1);',
    'globalThis.setInterval(() => {}, 1);',
    'globalThis.Date.now();',
    'new globalThis.Date();',
    'globalThis.performance.now();',
    'global.Date.now();',
    'window.setTimeout(() => {}, 1);',
    'self.Date.now();',
    "import { hrtime } from 'node:process'; hrtime();",
    "import { uptime } from 'process'; uptime();",
    "import { performance as p } from 'node:perf_hooks'; p.now();",
    "import { performance as p } from 'perf_hooks'; p.now();",
    "import { setTimeout as sleep } from 'node:timers/promises'; await sleep(1);",
    "import { setTimeout as sleep } from 'timers/promises'; await sleep(1);",
    "import { setInterval as every } from 'node:timers'; every(() => {}, 1);",
  ];

  it.each(banned)('rejects %s inside hail-core', async (code) => {
    expect(await clockErrors(code, 'packages/hail-core/src/x.ts')).toBeGreaterThan(0);
  });

  it.each(banned)('allows %s outside hail-core', async (code) => {
    expect(await clockErrors(code, 'packages/hail-service/src/x.ts')).toBe(0);
  });

  it('allows a Date built from a known instant', async () => {
    expect(await clockErrors('new Date(0);', 'packages/hail-core/src/x.ts')).toBe(0);
  });
});

describe('hail-core depends on nothing at runtime', () => {
  it('declares no dependencies', async () => {
    const manifest = JSON.parse(await readFile('packages/hail-core/package.json', 'utf8'));
    expect(manifest.dependencies ?? {}).toEqual({});
  });
});
