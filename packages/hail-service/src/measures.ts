// T3, T4 and T5's measurements (#66; QR1, QR2, QR3): M1 to M4c against their targets in m1-revised.md §7.3, read from
// the decision logs the hail coordinator writes when the replay (#16) drives it through each scenario, and from the
// oracle's call times (ADR-018) each scenario carries. M1, M4a and M4b are m1.ts's, m4a.ts's and m4b.ts's; M2, M3 and
// M4c are here. M1, M2 and M3 read the N = 1 scenarios, one hail per call; M4a, M4b and M4c read the N = 5 ones, whose
// approaches carry five passengers each (ADR-035 decision 3).
//
// Usage: node packages/hail-service/src/measures.ts
//   Reads every scenario under packages/replay/scenarios/ and its decision log under packages/replay/expected/, which
//   `npm run replay:check` holds to the replay, and prints for each D the table `| Class | Calls | M1 |` (ADR-034), then
//   `| Measure | Result | Target | Met |`, then what each count leaves out.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hails, m1, type Tally } from './m1.ts';
import { m4a } from './m4a.ts';
import { m4b } from './m4b.ts';
import { records, replayRuns } from './replay-runs.ts';
import type { Scenario } from './scenarios.ts';

// M2: each signal's margin before its own deadline, the last safe stopping point (ADR-023), from every `committed`
// record, which hands the hail's signal to SignalPort in the same transition (ADR-017). The target is that the worst
// tenth still arrives early: the nearest-rank tenth percentile of the margins is above 0. A commit on a stopped vehicle
// has no deadline (ADR-037), so no margin, and is left out, as T6 leaves it out (ADR-038, annotated 09-10-2026).
export function m2(logs: readonly (readonly string[])[]) {
  const margins: number[] = [];
  let noDeadline = 0;
  for (const { at, kind, payload } of logs.flatMap(records)) {
    if (kind !== 'committed') continue;
    if (payload.deadline === null) noDeadline++;
    else margins.push((payload.deadline as number) - at);
  }
  margins.sort((a, b) => a - b);
  return { signals: margins.length, early: margins.filter((m) => m > 0).length, worstTenthMs: margins[Math.ceil(margins.length / 10) - 1], noDeadline };
}

// M3: hails told an outcome, confirmed, unacknowledged or cannot hail (#61), before their target bus called at the stop
// on the oracle's time, over every hail (product.md §3, m1-revised.md §7.3). A hail committed on a stopped vehicle and
// spent before its run stops calling is told no outcome (ADR-032 and ADR-038, annotated 09-10-2026); it counts as not
// told, and `stopped` names it apart.
// ponytail: scored on each hail's first commit, as M1 is; no fixture scenario moves a hail.
export function m3(built: readonly Scenario[], logs: readonly (readonly string[])[]) {
  const n = { hails: 0, before: 0, after: 0, stopped: 0, committedUntold: 0, uncommitted: 0 };
  for (const { target, committed, told } of built.flatMap((s, i) => hails(s, logs[i]))) {
    n.hails++;
    if (told !== undefined) n[told < target.at ? 'before' : 'after']++;
    else if (committed) n[committed.deadline === null ? 'stopped' : 'committedUntold']++;
    else n.uncommitted++;
  }
  return n;
}

// M4c: approaches whose hail reached its deadline in Unattended (ADR-010 decision 6, `doc/design/product.md` §3): marked
// `unattended` and still on that approach, not spent, withdrawn, abandoned or moved, when its deadline came. A reported
// departure, `left`, ends Unattended (ADR-040 decision 5). A commit on a stopped vehicle has no deadline to reach.
export function m4c(log: readonly string[]): number {
  const unattendedAt = new Map<string, number>();
  const on = new Map<string, { approach: string; deadline: number | null }>();
  const counted = new Set<string>();
  const leave = (hailId: string, at: number) => {
    const was = on.get(hailId);
    const since = unattendedAt.get(hailId);
    if (was?.deadline != null && since !== undefined && since <= was.deadline && was.deadline <= at) counted.add(was.approach);
    on.delete(hailId);
  };
  for (const { kind, at, hailId, approach, payload } of records(log)) {
    if (kind === 'left') unattendedAt.delete(hailId!);
    if (kind === 'unattended') unattendedAt.set(hailId!, at);
    if (['spent', 'withdrawn', 'abandoned', 'committed'].includes(kind)) leave(hailId!, at);
    if (kind === 'committed') on.set(hailId!, { approach: approach!, deadline: payload.deadline as number | null });
  }
  for (const hailId of [...on.keys()]) leave(hailId, Infinity);
  return counted.size;
}

type Run = { built: Scenario[]; logs: string[][] };
const pct = (k: number, n: number) => (n ? `${((100 * k) / n).toFixed(1)}%` : '—');
// Met, or — when the measure has nothing to count.
const met = (n: number, ok: boolean) => (!n ? '—' : ok ? 'yes' : 'no');

// One D's tables and notes, from its N = 1 and N = 5 runs.
export function report(n1: Run, n5: Run): string[] {
  const t = m1(n1.built, n1.logs);
  const share = ({ calls, right }: Tally) => `${right} / ${calls} = ${pct(right, calls)}`;
  const m2r = m2(n1.logs);
  const m3r = m3(n1.built, n1.logs);
  const perApproach = n5.logs.flatMap(m4a);
  const corrections = n5.logs.map(m4b);
  const approaches = corrections.reduce((n, c) => n + c.approaches, 0);
  const corrected = corrections.reduce((n, c) => n + c.corrected, 0);
  const unattended = n5.logs.reduce((n, l) => n + m4c(l), 0);
  const s = (ms: number | undefined) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(3)} s`);
  return [
    `D = ${n1.built[0].dS} s: ${n1.built.length} scenarios at N = 1, ${n5.built.length} at N = 5`,
    '',
    '| Class | Calls | M1 |',
    '| --- | --- | --- |',
    `| Single on both | ${t['single-on-both'].calls} | ${share(t['single-on-both'])} |`,
    `| Queued on both | ${t['queued-on-both'].calls} | ${share(t['queued-on-both'])} |`,
    `| Disputed (class differs with AT's arrival times) | ${t.disputed.calls} | ${share(t.disputed)} |`,
    '',
    '| Measure | Result | Target | Met |',
    '| --- | --- | --- | --- |',
    `| M1, single on both | ${pct(t['single-on-both'].right, t['single-on-both'].calls)} | ≥ 95% | ${met(t['single-on-both'].calls, t['single-on-both'].right >= 0.95 * t['single-on-both'].calls)} |`,
    `| M1, queued on both | ${pct(t['queued-on-both'].right, t['queued-on-both'].calls)} | ≥ 80% | ${met(t['queued-on-both'].calls, t['queued-on-both'].right >= 0.8 * t['queued-on-both'].calls)} |`,
    `| M2, worst tenth's margin before the deadline | ${s(m2r.worstTenthMs)}; ${m2r.early} of ${m2r.signals} signals early | Worst tenth still early: > 0 s | ${met(m2r.signals, m2r.worstTenthMs > 0)} |`,
    `| M3, told the outcome before the bus called | ${m3r.before} / ${m3r.hails} = ${pct(m3r.before, m3r.hails)} | ≥ 99% | ${met(m3r.hails, m3r.before >= 0.99 * m3r.hails)} |`,
    '| M3, median from decision to presentation | Not measured by replay | ≤ 1 s | — |',
    `| M4a, signals per approach | 1 on ${perApproach.filter((k) => k === 1).length} of ${perApproach.length} approaches | Exactly 1 | ${met(perApproach.length, perApproach.every((k) => k === 1))} |`,
    `| M4b, approaches with a correction | ${corrected} / ${approaches} = ${pct(corrected, approaches)} | ≤ 10% | ${met(approaches, corrected <= 0.1 * approaches)} |`,
    `| M4c, approaches reaching their deadline in Unattended | ${unattended} / ${approaches} = ${pct(unattended, approaches)} | ≤ 5% | ${met(approaches, unattended <= 0.05 * approaches)} |`,
    '',
    `Within M3: ${m3r.stopped} hails committed on a stopped vehicle were spent before their run stopped calling, so were told no outcome (ADR-032 and ADR-038, annotated 09-10-2026).`,
    `M2 leaves out the ${m2r.noDeadline} commits on a stopped vehicle because they have no deadline, so no margin before one (ADR-037).`,
    `M3's ${m3r.hails - m3r.before} not told before the bus called: ${m3r.stopped} committed on a stopped vehicle, told nothing; ${m3r.committedUntold} committed with a deadline and spent before it, told nothing; ${m3r.uncommitted} never committed or abandoned; ${m3r.after} told after the call.`,
    `M3's latency: each outcome is recorded in the transition that decides it, so the replay has no delay to measure; the time to presentation is the passenger app's. No replayed scenario sends a console acknowledgement, so every committed hail's outcome is unacknowledged or none.`,
    `M4c: ${n5.logs.flatMap(records).filter((r) => r.kind === 'unattended').length} \`unattended\` records in the N = 5 logs.`,
  ];
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const n5 = replayRuns('-n5.json');
  for (const [i, n1] of replayRuns('-n1.json').entries()) console.log(`\n${report(n1, n5[i]).join('\n')}`);
}
