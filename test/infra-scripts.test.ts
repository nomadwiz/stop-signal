// Runs each offline check of an infra script, infra/test-*.sh, inside the suite, so CI's `suite` job runs them too.
// Each stubs aws and the host's commands on PATH and exits non-zero on any failed check.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scripts = readdirSync('infra').filter((f) => /^test-.*\.sh$/.test(f));

describe('infra scripts', () => {
  it('has offline checks to run', () => expect(scripts.length).toBeGreaterThan(0));

  it.each(scripts)('infra/%s passes', (script) => {
    const run = spawnSync('bash', [`infra/${script}`], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });
});
