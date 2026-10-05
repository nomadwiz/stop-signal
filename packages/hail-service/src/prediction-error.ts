// S2's measurement (#27, FR6): how far predict() puts a vehicle from where its later reports show it was, at
// horizons after its latest report. The method is ADR-033's; the prediction is the built one, from hail-core.
//
// Usage: node packages/hail-service/src/prediction-error.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> [route,…]
//   Reads every <root>/*/<epoch-ms>.pb.gz with from-ms <= epoch-ms < to-ms, for the bus trips (route_type 3) of
//   that one service day, and prints the error table for all of them, then for the routes named, by short name.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { predict, type Fix, type Point } from '../../hail-core/src/predict.ts';
import { snapshots } from './gtfs-realtime.ts';
import { loadServiceDay, type Route, type StaticIndex } from './gtfs-static.ts';

// ADR-033 keeps a horizon only where the fixes either side of it are at most one feed interval apart (ADR-022).
const BRACKET_MS = 30_000;

// errorM: predicted distance to go minus the distance the track gives at the same instant, metres; positive when the
// vehicle got further than predicted. errorS: that instant minus the nearest instant at which the track is at the
// predicted point, seconds, so positive likewise; null when the track never reaches it.
export interface HorizonError { horizonS: number; errorM: number; errorS: number | null }
// pairs: predictions made at the next report's time; stale: how many of those predict() flagged stale.
export interface Track { tripId: string; vehicleId: string; route: Route; pairs: number; stale: number; errors: HorizonError[] }

// One vehicle's fixes on one trip, in time order with no two at the same instant.
export function trackErrors(shape: Point[], fixes: Fix[], horizonsS: number[]): Pick<Track, 'pairs' | 'stale' | 'errors'> {
  // Distances are taken to the shape's end, so that one stop serves every instant; any point would do.
  const end = shape[shape.length - 1];
  const predictAt = (previous: Fix, latest: Fix, now: number) => predict(shape, end, previous, latest, now);
  // Each fix's own distance to go, read through predict with nothing to extrapolate.
  const togo = fixes.map((f) => predictAt({ ...f, at: f.at - 1 }, f, f.at).distanceM);
  // The track's distance to go at t, interpolated between the fixes k - 1 and k either side of it.
  const between = (k: number, t: number) => togo[k - 1] + ((t - fixes[k - 1].at) / (fixes[k].at - fixes[k - 1].at)) * (togo[k] - togo[k - 1]);

  let pairs = 0;
  let stale = 0;
  const errors: HorizonError[] = [];
  for (let i = 1; i < fixes.length - 1; i++) {
    pairs++;
    if (predictAt(fixes[i - 1], fixes[i], fixes[i + 1].at).stale) stale++;
    for (const horizonS of horizonsS) {
      const t = fixes[i].at + horizonS * 1000;
      let k = i + 1;
      while (k < fixes.length && fixes[k].at < t) k++;
      if (k === fixes.length || fixes[k].at - fixes[k - 1].at > BRACKET_MS) continue;
      const predicted = predictAt(fixes[i - 1], fixes[i], t).distanceM;
      errors.push({ horizonS, errorM: predicted - between(k, t), errorS: offset(fixes, togo, predicted, t) });
    }
  }
  return { pairs, stale, errors };
}

// t minus the instant nearest t at which the track's distance to go equals target, seconds; null if it never does.
function offset(fixes: Fix[], togo: number[], target: number, t: number): number | null {
  let best: number | null = null;
  for (let k = 1; k < fixes.length; k++) {
    const [a, b] = [togo[k - 1], togo[k]];
    if (target < Math.min(a, b) || target > Math.max(a, b)) continue;
    const [from, to] = [fixes[k - 1].at, fixes[k].at];
    // A segment where the vehicle stood at the point holds it throughout.
    const when = a === b ? Math.min(to, Math.max(from, t)) : from + ((target - a) / (b - a)) * (to - from);
    if (best === null || Math.abs(t - when) < Math.abs(t - best)) best = when;
  }
  return best === null ? null : (t - best) / 1000;
}

// Every trip and vehicle's track in the archive, grouped as actual-calls.ts groups them, with its errors.
export async function predictionErrors(index: StaticIndex, root: string, from: number, to: number, horizonsS = [15, 30]): Promise<Track[]> {
  const groups = new Map<string, { tripId: string; vehicleId: string; fixes: Fix[] }>();
  for await (const { feed } of snapshots(root, from, to)) {
    for (const { vehicle } of feed.entity) {
      // A missing trip_id decodes as '', and a missing timestamp as 0.
      const tripId = vehicle?.trip?.tripId;
      const at = Number(vehicle?.timestamp) * 1000;
      if (!tripId || !vehicle?.position || !at || vehicle.trip?.startDate !== index.day || !index.trips.has(tripId)) continue;
      const vehicleId = vehicle.vehicle?.id ?? '';
      const key = JSON.stringify([tripId, vehicleId]);
      const group = groups.get(key) ?? groups.set(key, { tripId, vehicleId, fixes: [] }).get(key)!;
      group.fixes.push({ at, lat: vehicle.position.latitude, lon: vehicle.position.longitude });
    }
  }

  const tracks: Track[] = [];
  for (const { tripId, vehicleId, fixes } of groups.values()) {
    const trip = index.trips.get(tripId)!;
    const shape = index.shapes.get(trip.shapeId);
    const route = index.routes.get(trip.routeId);
    if (!shape || shape.length < 2 || !route) continue;
    // A fix stays in the feed until the vehicle reports again, so successive snapshots repeat it.
    const distinct = fixes.sort((a, b) => a.at - b.at).filter((f, i, all) => i === 0 || f.at !== all[i - 1].at);
    tracks.push({ tripId, vehicleId, route, ...trackErrors(shape, distinct, horizonsS) });
  }
  return tracks;
}

// Nearest rank: the smallest value with at least p of them at or below it.
const rank = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const spread = (values: number[]) => {
  const sorted = values.map(Math.abs).sort((a, b) => a - b);
  return sorted.length ? [0.5, 0.9, 0.95].map((p) => rank(sorted, p).toFixed(1)).join(' / ') : '—';
};

// The markdown the CLI prints: absolute errors per horizon, and the share of predictions at the next report flagged stale.
export function report(tracks: Track[]): string {
  const errors = tracks.flatMap((t) => t.errors);
  const horizons = [...new Set(errors.map((e) => e.horizonS))].sort((a, b) => a - b);
  const pairs = tracks.reduce((n, t) => n + t.pairs, 0);
  const stale = tracks.reduce((n, t) => n + t.stale, 0);
  return [
    '| Horizon | Pairs | Error, m: median / p90 / p95 | Error, s: median / p90 / p95 | No error in s |',
    '| --- | --- | --- | --- | --- |',
    ...horizons.map((h) => {
      const at = errors.filter((e) => e.horizonS === h);
      const seconds = at.flatMap((e) => (e.errorS === null ? [] : [e.errorS]));
      return `| ${h} s | ${at.length} | ${spread(at.map((e) => e.errorM))} | ${spread(seconds)} | ${at.length - seconds.length} |`;
    }),
    '',
    `Stale at the next report: ${stale} / ${pairs} = ${pairs ? ((100 * stale) / pairs).toFixed(1) : '—'}%`,
  ].join('\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to, routeList] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to) {
    console.error('Usage: node packages/hail-service/src/prediction-error.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> [route,…]');
    process.exit(1);
  }
  const buses = (await predictionErrors(await loadServiceDay(zipPath, day), root, Number(from), Number(to))).filter((t) => t.route.type === 3);
  console.log(`Buses (route_type 3)\n\n${report(buses)}`);
  if (routeList) {
    const named = new Set(routeList.split(','));
    console.log(`\nRoutes ${[...named].join(', ')}\n\n${report(buses.filter((t) => named.has(t.route.shortName)))}`);
  }
}
