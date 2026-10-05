// C10: builds the replay scenarios for one stop, one per arrival per N, each adding synthesised passengers to a
// recorded arrival (#15, S9, ADR-035). #16 replays them; #24 and #36 read their classes and passengers.
//
// Usage: node packages/hail-service/src/scenarios.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <stop_id> <out dir> <D-seconds,…>
//   Derives the calls as actual-calls.ts does, then writes <out dir>/d<D>/<first call ms>-n<N>.json for N in 1 and 5,
//   and prints, per D, the arrivals and how many are single on both time sources, queued on both, and disputed.
import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { actualCalls, observedKey, type Call, type Observed } from './actual-calls.ts';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';
import { arrivals, boardable } from './queued-arrivals.ts';

export const PASSENGERS = [1, 5];
// How long before the arrival's first call a passenger registers and arrives, unless their route called later (ADR-035 decision 1).
export const LOOK_AHEAD_MS = 300_000;

type Class = 'single' | 'queued';
export interface Scenario {
  stopId: string;
  day: string;
  dS: number;
  n: number;
  class: Class;
  group: 'single-on-both' | 'queued-on-both' | 'disputed';
  // atArrival: AT's observed arrival, epoch ms, or null where AT recorded none; atArrivalClass: the call's class with it substituted.
  calls: { tripId: string; vehicleId: string; routeId: string; stopSequence: number; at: number; atArrival: number | null; atArrivalClass: Class }[];
  events: { at: number; event: HailEvent }[];
}

const classOf = (a: { vehicles: number }): Class => (a.vehicles >= 2 ? 'queued' : 'single');

// A UUID v4 (ADR-032) drawn from a hash, so the same scenario always gets the same handles.
function handle(seed: string): string {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Every arrival at the stop at D seconds, each with N passengers per route in it (ADR-035).
export function scenarios(calls: Call[], observed: Map<string, Observed>, index: StaticIndex, stopId: string, dS: number, n: number): Scenario[] {
  const mine = boardable(calls.filter((c) => c.stopId === stopId), index).sort((a, b) => a.at - b.at);
  const routeOf = (c: Call) => index.trips.get(c.tripId)!.routeId;
  // Each call's class when AT's arrival, never its departure, stands in for the oracle's time (ADR-034, ADR-035 decision 4).
  const atClass = new Map<string, Class>();
  for (const a of arrivals(mine.map((c) => ({ ...c, at: observed.get(observedKey(c))?.arrival ?? c.at })), dS * 1000)) {
    for (const c of a.calls) atClass.set(observedKey(c), classOf(a));
  }

  return arrivals(mine, dS * 1000).map((a) => {
    const first = a.calls[0].at;
    const cls = classOf(a);
    const scenarioCalls = a.calls.map((c) => ({
      tripId: c.tripId, vehicleId: c.vehicleId, routeId: routeOf(c), stopSequence: c.stopSequence, at: c.at,
      atArrival: observed.get(observedKey(c))?.arrival ?? null, atArrivalClass: atClass.get(observedKey(c))!,
    }));
    const disputed = scenarioCalls.some((c) => c.atArrivalClass !== cls);

    // Each route's first vehicle in the arrival is its passengers' target.
    const targets = scenarioCalls.filter((c, i) => scenarioCalls.findIndex((d) => d.routeId === c.routeId) === i);
    const starts: Scenario['events'] = [];
    const ends: Scenario['events'] = [];
    for (const [r, target] of targets.entries()) {
      const previous = mine.findLast((c) => c.at < first && routeOf(c) === target.routeId);
      const start = Math.max(first - LOOK_AHEAD_MS, previous ? previous.at + 1000 : -Infinity);
      for (let i = r * n; i < (r + 1) * n; i++) {
        const h = handle(`${stopId}|${first}|${dS}|${n}|${i}`);
        starts.push({ at: start, event: { kind: 'register', handle: h, stopId, routeId: target.routeId, leadTimeS: 0 } });
        starts.push({ at: start, event: { kind: 'presence-start', handle: h, stopId } });
        ends.push({ at: target.at, event: { kind: 'presence-end', handle: h, stopId } });
      }
    }

    return {
      stopId, day: index.day, dS, n, class: cls,
      group: disputed ? 'disputed' : cls === 'queued' ? 'queued-on-both' : 'single-on-both',
      calls: scenarioCalls,
      // A stable sort, so within one instant a passenger's register stays before their presence-start.
      events: [...starts, ...ends].sort((x, y) => x.at - y.at),
    };
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to, stopId, out, windows] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to || !stopId || !out || !windows) {
    console.error('Usage: node packages/hail-service/src/scenarios.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <stop_id> <out dir> <D-seconds,…>');
    process.exit(1);
  }
  const ds = windows.split(',').map(Number);
  if (![Number(from), Number(to), ...ds].every((x) => Number.isFinite(x) && x > 0)) {
    console.error(`from-ms, to-ms and every D must be positive numbers: ${from} ${to} ${windows}`);
    process.exit(1);
  }
  const index = await loadServiceDay(zipPath, day);
  const { calls, observed } = await actualCalls(index, root, Number(from), Number(to));
  for (const d of ds) {
    const dir = join(out, `d${d}`);
    mkdirSync(dir, { recursive: true });
    for (const n of PASSENGERS) {
      const built = scenarios(calls, observed, index, stopId, d, n);
      for (const s of built) writeFileSync(join(dir, `${s.calls[0].at}-n${n}.json`), JSON.stringify(s, null, 2) + '\n');
      if (n !== PASSENGERS[0]) continue;
      const count = (pick: (s: Scenario) => boolean) => built.filter(pick).length;
      console.log(`D = ${d} s: ${built.length} arrivals, ${count((s) => s.class === 'queued')} queued and ${count((s) => s.class === 'single')} single; `
        + `${count((s) => s.group === 'single-on-both')} single on both, ${count((s) => s.group === 'queued-on-both')} queued on both, `
        + `${count((s) => s.group === 'disputed')} disputed (${count((s) => s.group === 'disputed' && s.class === 'single')} single on the oracle, `
        + `${count((s) => s.group === 'disputed' && s.class === 'queued')} queued); ${built.length * PASSENGERS.length} files`);
    }
  }
}
