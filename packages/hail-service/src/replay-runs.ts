// The replay's scenarios of one size and each one's expected decision log, for the measurement scripts (m1, m4a, m4b, measures).
// Reads packages/replay/scenarios/ and packages/replay/expected/, one run per D, widest D first.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import type { Scenario } from './scenarios.ts';

// A decision log's records, each `committed` one with its approach: the (vehicle, stop) pair it commits on (ADR-011
// decision 1), the stop from the hail's `registered` record.
// ponytail: a scenario replays one window at one stop, so a vehicle's run there is its vehicle.
export function records(log: readonly string[]): (DecisionRecord & { approach?: string })[] {
  const stopOf = new Map<string, unknown>();
  return log.map((l) => {
    const r: DecisionRecord = JSON.parse(l);
    if (r.kind === 'registered') stopOf.set(r.hailId!, r.payload.stopId);
    return r.kind === 'committed' ? { ...r, approach: JSON.stringify([r.vehicleId, stopOf.get(r.hailId!)]) } : r;
  });
}

export function replayRuns(suffix: string): { d: string; files: string[]; built: Scenario[]; logs: string[][] }[] {
  const replay = (path: string) => fileURLToPath(new URL(`../../replay/${path}`, import.meta.url));
  return readdirSync(replay('scenarios')).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))).map((d) => {
    const files = readdirSync(replay(`scenarios/${d}`)).filter((f) => f.endsWith(suffix)).sort();
    const built: Scenario[] = files.map((f) => JSON.parse(readFileSync(replay(`scenarios/${d}/${f}`), 'utf8')));
    const logs = files.map((f) => readFileSync(replay(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').split('\n').filter(Boolean));
    return { d, files, built, logs };
  });
}
