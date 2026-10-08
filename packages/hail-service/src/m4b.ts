// T4's measurement (#39, QR3): M4b, the corrections per approach, and the withdrawal race, read from the decision log
// the replay (#16) writes. A correction is a `moved` retraction and the signal after it (ADR-011 annotation, 09-10-2026);
// `left` and `cancelled` are withdrawals, not corrections. A retraction writes no record (ADR-017 annotation), so a move
// shows as the same hail's second `committed`. The coordinator retracts only once no live hail is left on the signal
// (ADR-042); otherwise it re-sends the signal, so a move off a still-shared signal is no correction. M4b is the approaches
// a retraction was sent from, over all approaches. The target is at most 10% (m1-revised.md §7.3).
//
// The race is harmless only if the retraction reaches the console before the first vehicle's deadline (FR12). The
// retraction is sent at the `at` of the re-commit; the deadline is the one in the hail's previous `committed`, null
// meaning due at once, so a retraction after it is always late. Sent last from the signal, the hail's deadline is the
// signal's.
//
// Usage: node packages/hail-service/src/m4b.ts
//   Reads every N = 5 scenario under packages/replay/scenarios/ and its decision log under packages/replay/expected/
//   and prints for each D the table `| Group | Scenarios | Approaches | Corrected | M4b | Retractions | Late |` by group
//   (ADR-034 decision 2) and a total.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import type { Group } from './m1.ts';
import { replayRuns } from './replay-runs.ts';
import type { Scenario } from './scenarios.ts';

export interface M4b { approaches: number; corrected: number; retractions: number; late: number }

// ponytail: a scenario replays one window at one stop, so a vehicle's run there is its vehicle (as in m4a.ts).
export function m4b(log: readonly string[]): M4b {
  const stopOf = new Map<string, string>();
  const on = new Map<string, { approach: string; signalId: string; deadline: number | null }>();
  const approaches = new Set<string>();
  const corrected = new Set<string>();
  let retractions = 0;
  let late = 0;
  for (const { kind, at, hailId, vehicleId, payload } of log.map((l): DecisionRecord => JSON.parse(l))) {
    if (kind === 'registered') stopOf.set(hailId!, payload.stopId as string);
    if (['spent', 'withdrawn', 'abandoned'].includes(kind)) on.delete(hailId!);
    if (kind !== 'committed') continue;
    const was = on.get(hailId!);
    if (was && ![...on].some(([h, o]) => h !== hailId && o.signalId === was.signalId)) {
      corrected.add(was.approach);
      retractions++;
      if (was.deadline === null || at >= was.deadline) late++;
    }
    const approach = JSON.stringify([vehicleId, stopOf.get(hailId!)]);
    approaches.add(approach);
    on.set(hailId!, { approach, signalId: payload.signalId as string, deadline: payload.deadline as number | null });
  }
  return { approaches: approaches.size, corrected: corrected.size, retractions, late };
}

export type M4bRow = { scenarios: number } & M4b;

// Each scenario's M4b, summed by its file's group (ADR-034 decision 2).
export function m4bByGroup(built: readonly Scenario[], logs: readonly (readonly string[])[]): Record<Group, M4bRow> {
  const zero = (): M4bRow => ({ scenarios: 0, approaches: 0, corrected: 0, retractions: 0, late: 0 });
  const rows: Record<Group, M4bRow> = { 'single-on-both': zero(), 'queued-on-both': zero(), disputed: zero() };
  for (const [i, s] of built.entries()) {
    const row = rows[s.group];
    row.scenarios++;
    for (const [k, n] of Object.entries(m4b(logs[i]))) row[k as keyof M4b] += n;
  }
  return rows;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { d, files, built, logs } of replayRuns('-n5.json')) {
    const rows = Object.entries(m4bByGroup(built, logs));
    const all: M4bRow = { scenarios: 0, approaches: 0, corrected: 0, retractions: 0, late: 0 };
    for (const [, r] of rows) for (const k of Object.keys(all) as (keyof M4bRow)[]) all[k] += r[k];
    console.log(`\nD = ${d.slice(1)} s, ${files.length} scenarios at N = 5\n\n| Group | Scenarios | Approaches | Corrected | M4b | Retractions | Late |\n| --- | --- | --- | --- | --- | --- | --- |`);
    for (const [group, r] of [...rows, ['all', all] as const]) {
      console.log(`| ${group} | ${r.scenarios} | ${r.approaches} | ${r.corrected} | ${r.approaches ? ((100 * r.corrected) / r.approaches).toFixed(1) : '0'}% | ${r.retractions} | ${r.late} |`);
    }
  }
}
