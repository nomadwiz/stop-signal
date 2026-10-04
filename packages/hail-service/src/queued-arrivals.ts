// C7: finds queued arrivals, two or more vehicles reaching one stop within one window D, in the oracle's calls (#21, #15, S9, ADR-027).
//
// Usage: node packages/hail-service/src/queued-arrivals.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <D-seconds,…>
//   Derives the calls as actual-calls.ts does, then prints, for each D, the top 15 bus stops ranked by
//   queued arrivals at that D, with the queued and single counts at every D given.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { actualCalls, type Call } from './actual-calls.ts';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';

// vehicles: how many distinct vehicles made the calls. Queued when 2 or more.
export interface Arrival { stopId: string; calls: Call[]; vehicles: number }

// Each stop's calls in time order, grouped so that an arrival opens at the earliest call not yet grouped and takes
// every call up to windowMs after it. Sorted by stop, then time.
export function arrivals(calls: Call[], windowMs: number): Arrival[] {
  const sorted = [...calls].sort((a, b) => a.stopId.localeCompare(b.stopId) || a.at - b.at);
  const result: Arrival[] = [];
  for (const c of sorted) {
    const last = result.at(-1);
    if (last?.stopId === c.stopId && c.at - last.calls[0].at <= windowMs) last.calls.push(c);
    else result.push({ stopId: c.stopId, calls: [c], vehicles: 0 });
  }
  // A vehicle with no id decodes as '', so its trip stands in for it.
  for (const a of result) a.vehicles = new Set(a.calls.map((c) => c.vehicleId || `trip ${c.tripId}`)).size;
  return result;
}

// Queued and single arrivals per stop over calls on bus routes (route_type 3), most queued first, ties by stop_id.
// A call at its trip's first or last stop is left out (ADR-027): nobody boards at a last stop, and a first stop's
// call is the vehicle arriving before its trip starts.
export function rank(calls: Call[], index: StaticIndex, windowMs: number): { stopId: string; queued: number; single: number }[] {
  const bus = calls.filter((c) => {
    const trip = index.trips.get(c.tripId);
    const ends = [trip?.stopTimes[0]?.sequence, trip?.stopTimes.at(-1)?.sequence];
    return index.routes.get(trip?.routeId ?? '')?.type === 3 && !ends.includes(c.stopSequence);
  });
  const counts = new Map<string, { stopId: string; queued: number; single: number }>();
  for (const a of arrivals(bus, windowMs)) {
    const row = counts.get(a.stopId) ?? counts.set(a.stopId, { stopId: a.stopId, queued: 0, single: 0 }).get(a.stopId)!;
    if (a.vehicles >= 2) row.queued++;
    else row.single++;
  }
  return [...counts.values()].sort((a, b) => b.queued - a.queued || a.stopId.localeCompare(b.stopId));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to, windows] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to || !windows) {
    console.error('Usage: node packages/hail-service/src/queued-arrivals.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <D-seconds,…>');
    process.exit(1);
  }
  const ds = windows.split(',').map(Number);
  if (![Number(from), Number(to), ...ds].every((n) => Number.isFinite(n) && n > 0)) {
    console.error(`from-ms, to-ms and every D must be positive numbers: ${from} ${to} ${windows}`);
    process.exit(1);
  }
  const index = await loadServiceDay(zipPath, day);
  const { calls } = await actualCalls(index, root, Number(from), Number(to));
  const ranks = ds.map((d) => rank(calls, index, d * 1000));
  const at = ds.map((_, i) => new Map(ranks[i].map((r) => [r.stopId, r])));
  const routes = (stopId: string) => [...new Set((index.tripsAtStop.get(stopId) ?? [])
    .map((id) => index.routes.get(index.trips.get(id)?.routeId ?? ''))
    .filter((r) => r?.type === 3).map((r) => r!.shortName))].sort().join(', ');

  console.log(`${calls.length} calls derived; bus stops with a call: ${ranks[0].length}`);
  for (const [i, d] of ds.entries()) {
    const queued = ranks[i].reduce((n, r) => n + r.queued, 0);
    const single = ranks[i].reduce((n, r) => n + r.single, 0);
    console.log(`\nRanked at D = ${d} s: ${queued} queued and ${single} single arrivals; ${ranks[i].filter((r) => r.queued).length} stops with a queued arrival\n`);
    console.log(`| Rank | stop_id | Name | Routes | ${ds.map((x) => `Queued, D = ${x} s`).join(' | ')} | ${ds.map((x) => `Single, D = ${x} s`).join(' | ')} | Lat, lon |`);
    console.log(`| ${['---', '---', '---', '---', ...ds.map(() => '---'), ...ds.map(() => '---'), '---'].join(' | ')} |`);
    for (const [n, { stopId }] of ranks[i].slice(0, 15).entries()) {
      const stop = index.stops.get(stopId);
      const cells = (key: 'queued' | 'single') => at.map((m) => m.get(stopId)?.[key] ?? 0).join(' | ');
      console.log(`| ${n + 1} | ${stopId} | ${stop?.name ?? '?'} | ${routes(stopId)} | ${cells('queued')} | ${cells('single')} | ${stop?.lat}, ${stop?.lon} |`);
    }
  }
}
