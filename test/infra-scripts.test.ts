// Runs each offline check of an infra script, infra/test-*.sh, inside the suite, so CI's `suite` job runs them too.
// Each stubs aws and the host's commands on PATH and exits non-zero on any failed check.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const infra = fileURLToPath(new URL('../infra/', import.meta.url));
const scripts = readdirSync(infra).filter((f) => /^test-.*\.sh$/.test(f));

describe('infra scripts', () => {
  it('has offline checks to run', () => expect(scripts.length).toBeGreaterThan(0));

  // Each script's mktemp -d folders go under a TMPDIR of its own, removed after it. The test's timeout is above
  // spawnSync's, so a script slower than vitest's 5 s default passes, and a hung one fails with its own output.
  it.each(scripts)('infra/%s passes', (script) => {
    const dir = mkdtempSync(join(tmpdir(), 'infra-'));
    try {
      const run = spawnSync('bash', [join(infra, script)], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: dir } });
      expect(run.status, `signal ${run.signal}, error ${run.error}\n${run.stdout}${run.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 70_000);
});
