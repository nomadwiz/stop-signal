// T6's degradation drill (#42, FR14, QR7): the feed withheld mid-hail in replay, C5's warning (`abandoned {reason:
// 'feed'}`, ADR-017 annotated 09-10-2026) must come before the deadline. No gap between fixture snapshots exceeds
// 20.006 s, so the outage removes snapshots, in memory: CI re-hashes every fixture (ADR-030 decision 4).
//
// Usage, to print the margins: npx vitest run packages/replay/src/drill.test.ts --silent=false
//
// One drill per arrival at each D: the n1 scenario (ADR-035). The feed stops when its hails become eligible, the
// decision window's start (ADR-041), and resumes two feed intervals later, after the watchdog's wakeup: a replay fires a
// wakeup only before a later input. The deadline is the one the hail's commit names in T7's expected log, the feed
// intact. Not drilled: an arrival none of whose hails becomes eligible. Not measured: a hail that log commits with no
// deadline (a stopped vehicle, due at once) or never commits, and a hail the drill still commits before the warning,
// whose signal has already gone.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FEED_INTERVAL_MS } from '../../hail-core/src/predict.ts';
import type { Scenario } from '../../hail-service/src/scenarios.ts';
import { fixtures, here, inputs, replay } from './replay.ts';

describe('T6: the feed withheld mid-hail', async () => {
  const { index, snaps } = await fixtures();

  it('warns every hail before its deadline, with the margin recorded', () => {
    for (const d of ['d17.4', 'd5.8']) {
      const margins: number[] = [];
      let drills = 0;
      const files = readdirSync(here(`scenarios/${d}`)).filter((f) => f.endsWith('-n1.json'));
      for (const f of files) {
        const scenario: Scenario = JSON.parse(readFileSync(here(`scenarios/${d}/${f}`), 'utf8'));
        const intact = readFileSync(here(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        const cut = intact.find((r) => r.kind === 'eligible')?.at;
        if (cut === undefined) continue;
        drills++;
        const resume = snaps.find((s) => s.at >= cut + 2 * FEED_INTERVAL_MS)!;
        const drill = replay(index, inputs([...snaps.filter((s) => s.at < cut), resume], scenario.events)).map((l) => JSON.parse(l));
        for (const c of intact.filter((r) => r.kind === 'committed' && r.payload.deadline !== null)) {
          const mine = drill.filter((r) => r.hailId === c.hailId);
          if (mine.some((r) => r.kind === 'committed')) continue;
          const warning = mine.find((r) => r.kind === 'abandoned' && r.payload.reason === 'feed');
          margins.push(c.payload.deadline - (warning?.at ?? Infinity));
        }
      }
      margins.sort((a, b) => a - b);
      const s = (ms: number) => `${(ms / 1000).toFixed(3)} s`;
      console.log(`T6 ${d}: ${drills} drills, ${margins.length} hails measured; margin min ${s(margins[0])}, median ${s((margins[(margins.length - 1) >> 1] + margins[margins.length >> 1]) / 2)}, max ${s(margins.at(-1)!)}`);
      expect(margins.length).toBeGreaterThan(0);
      expect(margins[0]).toBeGreaterThan(0);
    }
  }, 60_000);
});
