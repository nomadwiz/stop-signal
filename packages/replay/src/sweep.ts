// #67's sensitivity check (QR1, m1-revised.md §1.4 and §7.3): M2 across the comfortable deceleration band. The deadline
// takes each vehicle's speed v and a deceleration a (ADR-023), so D = 2.0 s + v / a is an output, not an input, and the
// sweep is over a ∈ [0.9, 1.47] m/s² (ADR-023 decision 2). The commit instant moves with the deadline (ADR-037), so
// each a replays the N = 1 scenarios afresh rather than rereading the expected logs, which are a = 0.9's.
//
// Usage: node packages/replay/src/sweep.ts
//   Replays every N = 1 scenario under packages/replay/scenarios/ over the fixture window at each a in DECELS, and
//   prints per scenario set `| a | D its signals span | M2, worst tenth | Signals early | Met | Stopped, left out |`.
//   About 10 s per a per set.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ServiceDay } from '../../hail-core/src/coordinator.ts';
import { stoppingBudget, T_PR } from '../../hail-core/src/deadline.ts';
import { m2 } from '../../hail-service/src/measures.ts';
import { replayRuns } from '../../hail-service/src/replay-runs.ts';
import { fixtures, inputs, replay, type Snapshot, type Timed } from './replay.ts';

// Both ends of the band, and every tenth between.
const DECELS = [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.47];

// For each a: M2 over the replayed logs, and the least and greatest D among its signals. A signal's speed is recovered
// from its first send, where distanceM and the deadline are both its commit's: ADR-023 decision 1 puts the deadline
// where d = v · (t_pr + margin) + v² / 2a, solved here for v.
// ponytail: a hail that joins a live signal adds no speed, since the signal then carries the earliest deadline and the
// latest distance. The script warns when that leaves any signal's D out; no N = 1 fixture scenario does.
export function sweep(index: ServiceDay, snaps: readonly Snapshot[], scenarios: readonly (readonly Timed[])[], decels = DECELS) {
  return decels.map((a) => {
    const d: number[] = [];
    const logs = scenarios.map((events) => {
      const sent = new Set<string>();
      return replay(index, inputs(snaps, events), a, {
        signal: ({ id, at, distanceM, deadline }) => {
          if (sent.has(id) || deadline === null) return;
          sent.add(id);
          const k = T_PR + (deadline - at) / 1000;
          d.push(stoppingBudget(a * (Math.sqrt(k * k + (2 * distanceM) / a) - k), a));
        },
        retract: () => {},
      });
    });
    return { a, m2: m2(logs), dS: [Math.min(...d), Math.max(...d)], spanned: d.length };
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { index, snaps } = await fixtures();
  for (const { d, built } of replayRuns('-n1.json')) {
    console.log(`\nScenarios ${d}: ${built.length} at N = 1\n\n| a | D its signals span | M2, worst tenth | Signals early | Met | Stopped, left out |\n| --- | --- | --- | --- | --- | --- |`);
    for (const { a, m2: r, dS, spanned } of sweep(index, snaps, built.map((s) => s.events))) {
      console.log(`| ${a.toFixed(2)} m/s² | ${spanned ? `${dS[0].toFixed(1)}–${dS[1].toFixed(1)} s` : '—'} | ${(r.worstTenthMs / 1000).toFixed(3)} s | ${r.early} of ${r.signals} | ${r.worstTenthMs > 0 ? 'yes' : 'no'} | ${r.noDeadline} |`);
      if (spanned !== r.signals) console.warn(`  D spans ${spanned} of ${r.signals} signals at ${a}: the rest joined a live signal.`);
    }
    console.log('\nM2 leaves out each commit on a stopped vehicle, which has no deadline (ADR-037).');
  }
}
