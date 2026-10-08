// S1's measurement (#24, FR5, QR2, T3): M1, the share of hails committed on the vehicle that actually called at the
// stop, per call, in ADR-034's three groups, read from the decision log the hail coordinator writes when the replay
// (#16) drives it through each scenario (ADR-037 decision 2). Also counts what ADR-041 decision 3 and ADR-039's open
// item ask of the same logs.
//
// Usage: node packages/hail-service/src/m1.ts
//   Reads every N = 1 scenario under packages/replay/scenarios/ and its decision log under packages/replay/expected/,
//   which `npm run replay:check` holds to the replay, and prints for each D the table `| Class | Calls | M1 |`.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import type { Scenario } from './scenarios.ts';

// One hail as its decision log tells it: its route and the call its passengers want (ADR-035 decision 3), when it was
// registered and became eligible, its first commit, its abandonment, and every skip it wrote.
export interface Hail {
  routeId: string;
  target: Scenario['calls'][number];
  registered: number;
  eligible?: number;
  committed?: { at: number; vehicleId: string; deadline: number | null };
  abandoned?: string;
  skipped: { at: number; candidates: string[] }[];
}

// Every hail in a scenario's decision log, in the order registered.
export function hails(scenario: Scenario, log: readonly string[]): Hail[] {
  const byId = new Map<string, Hail>();
  for (const { at, kind, hailId, vehicleId, payload } of log.map((l): DecisionRecord => JSON.parse(l))) {
    if (kind === 'registered') {
      const routeId = payload.routeId as string;
      byId.set(hailId!, { routeId, target: scenario.calls.find((c) => c.routeId === routeId)!, registered: at, skipped: [] });
      continue;
    }
    const h = byId.get(hailId!)!;
    if (kind === 'eligible') h.eligible ??= at;
    if (kind === 'committed') h.committed ??= { at, vehicleId: vehicleId!, deadline: payload.deadline as number | null };
    if (kind === 'abandoned') h.abandoned = payload.reason as string;
    if (kind === 'skipped') h.skipped.push({ at, candidates: payload.candidates as string[] });
  }
  return [...byId.values()];
}

export type Group = 'single-on-both' | 'queued-on-both' | 'disputed';
export interface Tally { calls: number; right: number; wrong: number; none: number }

// Each passenger group's first commit, scored against its target call. A call is in a group by its own class on the
// oracle's times and on AT's arrival times (ADR-034 decision 2). Each call counts once, on its route's first hail: N
// passengers on a route resolve alike. A hail never committed, abandoned or not, has none.
export function m1(built: readonly Scenario[], logs: readonly (readonly string[])[]): Record<Group, Tally> {
  const tally: Record<Group, Tally> = {
    'single-on-both': { calls: 0, right: 0, wrong: 0, none: 0 },
    'queued-on-both': { calls: 0, right: 0, wrong: 0, none: 0 },
    disputed: { calls: 0, right: 0, wrong: 0, none: 0 },
  };
  for (const [i, s] of built.entries()) {
    const counted = new Set<string>();
    for (const { routeId, target, committed } of hails(s, logs[i])) {
      if (counted.has(routeId)) continue;
      counted.add(routeId);
      const row = tally[target.atArrivalClass === s.class ? (`${s.class}-on-both` as const) : 'disputed'];
      row.calls++;
      row[!committed ? 'none' : committed.vehicleId === target.vehicleId ? 'right' : 'wrong']++;
    }
  }
  return tally;
}

// ADR-041 decision 3's test of the 30 s dwell, and ADR-039's open item. afterCommitInstant: hails that commit on a
// deadline the instant they become eligible, which the coordinator does only once deadline − FEED_INTERVAL_MS has
// passed (ADR-037, annotated 07-10-2026). afterDeadline: hails that skip their target the instant they become eligible,
// which the coordinator does to a moving, fresh vehicle already inside its stopping distance (ADR-039). registeredInside:
// hails that skip their target as they register, for the same reason. A stale target inside its stopping distance is
// not skipped (ADR-039 decision 5), so the log cannot show it, and none of the three counts it.
export function dwell(hs: readonly Hail[]) {
  const skippedAt = (h: Hail, at: number | undefined) => h.skipped.some((s) => s.at === at && s.candidates.includes(h.target.vehicleId));
  return {
    hails: hs.length,
    eligible: hs.filter((h) => h.eligible !== undefined).length,
    afterCommitInstant: hs.filter((h) => h.committed && h.committed.at === h.eligible && h.committed.deadline !== null).length,
    afterDeadline: hs.filter((h) => skippedAt(h, h.eligible)).length,
    registeredInside: hs.filter((h) => skippedAt(h, h.registered)).length,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const replay = (path: string) => fileURLToPath(new URL(`../../replay/${path}`, import.meta.url));
  const share = ({ calls: n, right }: Tally) => `${right} / ${n} = ${n ? ((100 * right) / n).toFixed(1) : '—'}%`;
  for (const d of readdirSync(replay('scenarios')).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)))) {
    const files = readdirSync(replay(`scenarios/${d}`)).filter((f) => f.endsWith('-n1.json')).sort();
    const built: Scenario[] = files.map((f) => JSON.parse(readFileSync(replay(`scenarios/${d}/${f}`), 'utf8')));
    const logs = files.map((f) => readFileSync(replay(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').split('\n').filter(Boolean));
    const t = m1(built, logs);
    const all = Object.values(t);
    console.log(`\nD = ${built[0].dS} s, ${built.length} arrivals\n\n| Class | Calls | M1 |\n| --- | --- | --- |`);
    for (const [group, label] of [['single-on-both', 'Single on both'], ['queued-on-both', 'Queued on both'], ['disputed', "Disputed (class differs with AT's arrival times)"]] as const) {
      console.log(`| ${label} | ${t[group].calls} | ${share(t[group])} |`);
    }
    const hs = built.flatMap((s, i) => hails(s, logs[i]));
    const c = dwell(hs);
    console.log(`\nNot right: ${all.reduce((n, x) => n + x.wrong, 0)} on the wrong vehicle, ${all.reduce((n, x) => n + x.none, 0)} with no commit before the call, of which ${hs.filter((h) => h.abandoned && !h.committed).length} hails were abandoned.`);
    console.log(`Of ${c.hails} hails, ${c.eligible} became eligible: ${c.afterCommitInstant} after their commit instant, committing at once; ${c.afterDeadline} after their target's deadline, skipping it.`);
    console.log(`${c.registeredInside} registered with their target already inside its stopping distance.`);
  }
}
