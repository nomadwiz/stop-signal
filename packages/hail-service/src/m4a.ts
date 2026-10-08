// T4's measurement (#36, QR3): M4a, the distinct signals per approach, read from the decision log the hail coordinator
// writes when the replay (#16) drives it through each N = 5 scenario (ADR-035 decision 3). An approach is one (vehicle,
// stop) pair with at least one committed hail (ADR-011 decision 1), and a `committed` record's `signalId` is shared by
// every hail its signal collapses (ADR-042), so M4a counts distinct signalIds, not SignalPort calls. The bar is 1.
//
// Usage: node packages/hail-service/src/m4a.ts
//   Reads every N = 5 scenario under packages/replay/scenarios/ and its decision log under packages/replay/expected/,
//   which `npm run replay:check` holds to the replay, and prints for each D the table
//   `| Group | Scenarios | With no commit | Approaches | M4a |` by each file's group (ADR-034 decision 2), then every
//   scenario with an approach whose M4a is not 1. A scenario with no commit has no approach, so no M4a; M1 counts its
//   calls as none.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import type { Scenario } from './scenarios.ts';

// Signals per approach in one decision log, in the order each approach first commits.
// ponytail: a scenario replays one window at one stop, so a vehicle's run there is its vehicle; nothing retracts until
// #38, so no retract-and-recommit pair exists to ignore. #38 excludes those pairs here once it writes them.
export function m4a(log: readonly string[]): number[] {
  const stopOf = new Map<string, string>();
  const signals = new Map<string, Set<string>>();
  for (const { kind, hailId, vehicleId, payload } of log.map((l): DecisionRecord => JSON.parse(l))) {
    if (kind === 'registered') stopOf.set(hailId!, payload.stopId as string);
    if (kind !== 'committed') continue;
    const approach = JSON.stringify([vehicleId, stopOf.get(hailId!)]);
    signals.set(approach, (signals.get(approach) ?? new Set()).add(payload.signalId as string));
  }
  return [...signals.values()].map((s) => s.size);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const replay = (path: string) => fileURLToPath(new URL(`../../replay/${path}`, import.meta.url));
  for (const d of readdirSync(replay('scenarios')).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
    const files = readdirSync(replay(`scenarios/${d}`)).filter((f) => f.endsWith('-n5.json')).sort();
    const rows = new Map<Scenario['group'], { scenarios: number; uncommitted: number; approaches: number[] }>(
      (['single-on-both', 'queued-on-both', 'disputed'] as const).map((g) => [g, { scenarios: 0, uncommitted: 0, approaches: [] }]),
    );
    const off: string[] = [];
    for (const f of files) {
      const s: Scenario = JSON.parse(readFileSync(replay(`scenarios/${d}/${f}`), 'utf8'));
      const counts = m4a(readFileSync(replay(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').split('\n').filter(Boolean));
      const row = rows.get(s.group)!;
      row.scenarios++;
      if (!counts.length) row.uncommitted++;
      row.approaches.push(...counts);
      if (counts.some((n) => n !== 1)) off.push(`${d}/${f}: ${counts.join(', ')}`);
    }
    console.log(`\nD = ${d.slice(1)} s, ${files.length} scenarios at N = 5\n\n| Group | Scenarios | With no commit | Approaches | M4a |\n| --- | --- | --- | --- | --- |`);
    for (const [group, { scenarios, uncommitted, approaches: a }] of rows) {
      const one = a.filter((n) => n === 1).length;
      console.log(`| ${group} | ${scenarios} | ${uncommitted} | ${a.length} | ${one === a.length ? `1 on all ${a.length}` : `1 on ${one} of ${a.length}, at most ${Math.max(...a)}`} |`);
    }
    console.log(off.length ? `\nM4a is not 1 in:\n${off.join('\n')}` : '\nM4a is 1 on every approach.');
  }
}
