// T4's measurement (#39, QR3): M4b, the corrections per approach, and the withdrawal race, read from the decision log
// the replay (#16) writes. A correction is a `moved` retraction and the signal after it (ADR-011 annotation, 09-10-2026);
// `left` and `cancelled` are withdrawals, not corrections. A retraction writes no record (ADR-017 annotation), so a move
// shows as the same hail's second `committed`, and M4b is the approaches a hail committed on and then left that way,
// over all approaches. The target is at most 10% (m1-revised.md §7.3).
//
// The race is harmless only if the retraction reaches the console before the first vehicle's deadline (FR12). The
// retraction is sent at the `at` of the re-commit; the deadline is the one in the hail's previous `committed`, null
// meaning due at once, so a retraction after it is always late. A signal shared by several hails may carry an earlier
// deadline than the hail's own, which the log does not hold: the comparison is against the hail's.
//
// Usage: node packages/hail-service/src/m4b.ts
//   Reads every N = 5 scenario under packages/replay/scenarios/ and its decision log under packages/replay/expected/
//   and prints for each D the table `| Group | Scenarios | Approaches | Corrected | M4b | Late |` by group (ADR-034
//   decision 2), then every scenario with a late retraction.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import type { Group } from './m1.ts';
import type { Scenario } from './scenarios.ts';

export interface M4b { approaches: number; corrected: number; late: number }

// ponytail: a scenario replays one window at one stop, so a vehicle's run there is its vehicle (as in m4a.ts).
export function m4b(log: readonly string[]): M4b {
  const stopOf = new Map<string, string>();
  const last = new Map<string, { approach: string; deadline: number | null }>();
  const approaches = new Set<string>();
  const corrected = new Set<string>();
  let late = 0;
  for (const { kind, at, hailId, vehicleId, payload } of log.map((l): DecisionRecord => JSON.parse(l))) {
    if (kind === 'registered') stopOf.set(hailId!, payload.stopId as string);
    if (kind !== 'committed') continue;
    const approach = JSON.stringify([vehicleId, stopOf.get(hailId!)]);
    const before = last.get(hailId!);
    if (before) {
      corrected.add(before.approach);
      if (before.deadline === null || at >= before.deadline) late++;
    }
    approaches.add(approach);
    last.set(hailId!, { approach, deadline: payload.deadline as number | null });
  }
  return { approaches: approaches.size, corrected: corrected.size, late };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const replay = (path: string) => fileURLToPath(new URL(`../../replay/${path}`, import.meta.url));
  for (const d of readdirSync(replay('scenarios')).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
    const files = readdirSync(replay(`scenarios/${d}`)).filter((f) => f.endsWith('-n5.json')).sort();
    const rows = new Map<Group, { scenarios: number } & M4b>();
    const lates: string[] = [];
    for (const f of files) {
      const s: Scenario = JSON.parse(readFileSync(replay(`scenarios/${d}/${f}`), 'utf8'));
      const r = m4b(readFileSync(replay(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').split('\n').filter(Boolean));
      const row = rows.get(s.group) ?? { scenarios: 0, approaches: 0, corrected: 0, late: 0 };
      rows.set(s.group, { scenarios: row.scenarios + 1, approaches: row.approaches + r.approaches, corrected: row.corrected + r.corrected, late: row.late + r.late });
      if (r.late) lates.push(`${d}/${f}: ${r.late}`);
    }
    console.log(`\nD = ${d.slice(1)} s, ${files.length} scenarios at N = 5\n\n| Group | Scenarios | Approaches | Corrected | M4b | Late |\n| --- | --- | --- | --- | --- | --- |`);
    const all = { scenarios: 0, approaches: 0, corrected: 0, late: 0 };
    for (const [group, r] of [...rows, ['all', all] as const]) {
      if (r !== all) for (const k of Object.keys(all) as (keyof typeof all)[]) all[k] += r[k];
      console.log(`| ${group} | ${r.scenarios} | ${r.approaches} | ${r.corrected} | ${r.approaches ? ((100 * r.corrected) / r.approaches).toFixed(1) : '0'}% | ${r.late} |`);
    }
    console.log(lates.length ? `\nA retraction at or after the first vehicle's deadline in:\n${lates.join('\n')}` : "\nEvery retraction is before the first vehicle's deadline.");
  }
}
