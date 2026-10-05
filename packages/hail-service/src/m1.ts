// S1's measurement (#24, FR5, QR2, T3): M1, the share of hails committed on the vehicle that actually called at the
// stop, per call, in ADR-034's three groups. Until #32 builds the commit, it is modelled here as ADR-037 decides it.
//
// Usage: node packages/hail-service/src/m1.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <stop_id> <D-seconds,…>
//   Derives the oracle's calls and one passenger per route per arrival (scenarios.ts, ADR-035), resolves each
//   passenger's route on the snapshots, and prints for each D the table `| Class | Calls | M1 |` with the misses.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signalDeadline } from '../../hail-core/src/deadline.ts';
import { FEED_INTERVAL_MS, predict } from '../../hail-core/src/predict.ts';
import { callingAt, type VehicleReport } from '../../hail-core/src/resolve.ts';
import { actualCalls, CALL_RADIUS_M } from './actual-calls.ts';
import { snapshots, vehicleReports } from './gtfs-realtime.ts';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';
import { windowsArg } from './queued-arrivals.ts';
import { scenarios, type Scenario } from './scenarios.ts';

// ADR-023's service default, the deceleration behind QR1's 17.4 s bound.
const DECEL_MPS2 = 0.9;

export interface Snapshot { at: number; reports: VehicleReport[] }

// For a stop and the snapshots in time order: the vehicle a hail on a route, armed from `from` to `to`, commits on,
// and when; null when it commits on none. The commit is ADR-037's: on the nearest calling vehicle of the route
// (ADR-036), one feed interval before its deadline at DECEL_MPS2, or at once if that instant has passed; never on a
// stale prediction (ADR-023's and ADR-037's [DECIDED:05-10-2026]); and on a stopped vehicle whose prediction is not
// stale at once when it is no further than its previous stop plus CALL_RADIUS_M, otherwise not until it moves or
// reports again (ADR-037's [DECIDED:05-10-2026] on a stopped vehicle). A passed deadline commits nothing (ADR-023).
export function commits(index: StaticIndex, stopId: string, snaps: Snapshot[]) {
  const stop = index.stops.get(stopId)!;
  const tripOf = (r: VehicleReport) => (r.startDate === index.previousDay ? index.lateTrips : index.trips).get(r.tripId!);
  // Every vehicle run's distinct fixes, so each report finds the one before it.
  const runs = new Map<string, VehicleReport[]>();
  const run = (r: VehicleReport) => `${r.vehicleId}|${r.tripId}|${r.startDate}`;
  for (const { reports } of snaps) {
    for (const r of reports) {
      const fixes = runs.get(run(r)) ?? runs.set(run(r), []).get(run(r))!;
      if (!fixes.some((f) => f.at === r.at)) fixes.push(r);
    }
  }
  // In fix order, as actual-calls.ts keeps them, in case a feed re-serves an older fix in a later snapshot.
  for (const fixes of runs.values()) fixes.sort((a, b) => a.at - b.at);
  // Each fix's match along its trip's shape, carried on from the fix before it (ADR-022 decision 5). A run's first fix
  // is matched over the whole shape, by predict with nothing to extrapolate.
  const alongs = new Map<VehicleReport, number>();
  for (const fixes of runs.values()) {
    const shape = index.shapes.get(tripOf(fixes[0])?.shapeId ?? '');
    if (!shape || shape.length < 2) continue;
    alongs.set(fixes[0], predict(shape, stop, { ...fixes[0], at: fixes[0].at - 1 }, fixes[0], fixes[0].at).alongM);
    for (let k = 1; k < fixes.length; k++) alongs.set(fixes[k], predict(shape, stop, fixes[k - 1], fixes[k], fixes[k].at, alongs.get(fixes[k - 1])).alongM);
  }

  // Metres along a report's trip shape from the trip's stop before stopId to stopId, plus CALL_RADIUS_M; -1 when stopId
  // is its first stop, so no stopped vehicle on it is due.
  // ponytail: places that stop by predict at speed 0, nearest over the whole shape, as predict places stopId itself.
  const reach = (r: VehicleReport) => {
    const trip = tripOf(r)!;
    const previous = index.stops.get(trip.stopTimes[trip.stopTimes.findIndex((s) => s.stopId === stopId) - 1]?.stopId);
    return previous ? predict(index.shapes.get(trip.shapeId)!, stop, { ...previous, at: 0 }, { ...previous, at: 1 }, 1).distanceM + CALL_RADIUS_M : -1;
  };

  // The nearest calling vehicle of routeId at t, on the latest snapshot at or before t, with S2's prediction.
  const pick = (t: number, routeId: string) => {
    const snap = snaps.findLast((s) => s.at <= t);
    const predicted = new Map<VehicleReport, ReturnType<typeof predict>>();
    for (const r of snap?.reports ?? []) {
      const trip = tripOf(r);
      const shape = index.shapes.get(trip?.shapeId ?? '');
      const previous = runs.get(run(r))!.findLast((f) => f.at < r.at);
      if (trip?.routeId !== routeId || !shape || shape.length < 2 || !previous) continue;
      predicted.set(r, predict(shape, stop, previous, r, t, alongs.get(previous)));
    }
    const [first] = callingAt(index, stopId, [...predicted].map(([report, p]) => ({ report, distanceM: p.distanceM > 0 ? p.distanceM : null })));
    return first && { report: first.report, ...predicted.get(first.report)! };
  };

  return (routeId: string, from: number, to: number): { vehicleId: string; at: number } | null => {
    const armed = snaps.filter((s) => s.at >= from && s.at <= to);
    for (const [k, { at: now }] of armed.entries()) {
      const p = pick(now, routeId);
      if (!p) continue;
      let at: number | undefined;
      if (p.speedMps === 0) {
        if (!p.stale && p.distanceM <= reach(p.report)) at = now;
      } else {
        const d = signalDeadline(now, p.distanceM, p.speedMps, DECEL_MPS2);
        if (d && d.deadline - FEED_INTERVAL_MS < (armed[k + 1]?.at ?? to)) at = Math.max(now, d.deadline - FEED_INTERVAL_MS);
      }
      if (at === undefined) continue;
      const c = at === now ? p : pick(at, routeId);
      if (c && !c.stale) return { vehicleId: c.report.vehicleId, at };
    }
    return null;
  };
}

export type Group = 'single-on-both' | 'queued-on-both' | 'disputed';
export interface Tally { calls: number; right: number; wrong: number; none: number }

// Each passenger group's commit, scored against its target call: the first call of its route in the arrival (ADR-035
// decision 3), armed from its registration to that call. A call is in a group by its own class on the oracle's times and
// on AT's arrival times (ADR-034 decision 2). Each call counts once: N passengers on a route resolve alike.
export function m1(index: StaticIndex, stopId: string, snaps: Snapshot[], built: Scenario[]): Record<Group, Tally> {
  const commitOf = commits(index, stopId, snaps);
  const tally: Record<Group, Tally> = {
    'single-on-both': { calls: 0, right: 0, wrong: 0, none: 0 },
    'queued-on-both': { calls: 0, right: 0, wrong: 0, none: 0 },
    disputed: { calls: 0, right: 0, wrong: 0, none: 0 },
  };
  for (const s of built) {
    const counted = new Set<string>();
    for (const { at, event } of s.events) {
      if (event.kind !== 'register' || counted.has(event.routeId)) continue;
      counted.add(event.routeId);
      const target = s.calls.find((c) => c.routeId === event.routeId)!;
      const row = tally[target.atArrivalClass === s.class ? (`${s.class}-on-both` as const) : 'disputed'];
      const c = commitOf(event.routeId, at, target.at);
      row.calls++;
      row[c === null ? 'none' : c.vehicleId === target.vehicleId ? 'right' : 'wrong']++;
    }
  }
  return tally;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to, stopId, windows] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to || !stopId || !windows) {
    console.error('Usage: node packages/hail-service/src/m1.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> <stop_id> <D-seconds,…>');
    process.exit(1);
  }
  const ds = windowsArg(from, to, windows);
  const index = await loadServiceDay(zipPath, day);
  // Only trips that call at the stop: callingAt turns every other one away.
  const calling = new Set(index.tripsAtStop.get(stopId));
  const snaps: Snapshot[] = [];
  for await (const { at, feed } of snapshots(root, Number(from), Number(to))) snaps.push({ at, reports: vehicleReports(feed, index).filter((r) => calling.has(r.tripId!)) });
  if (!snaps.length) {
    console.error(`no snapshots in [${from}, ${to}) under ${root}`);
    process.exit(1);
  }
  const { calls, observed } = await actualCalls(index, root, Number(from), Number(to));
  console.log(`${snaps.length} snapshots, ${new Date(snaps[0].at).toISOString()} to ${new Date(snaps.at(-1)!.at).toISOString()}; stop ${stopId}`);
  const share = ({ calls: n, right }: Tally) => `${right} / ${n} = ${n ? ((100 * right) / n).toFixed(1) : '—'}%`;
  for (const d of ds) {
    const t = m1(index, stopId, snaps, scenarios(calls, observed, index, stopId, d, 1));
    const all = Object.values(t);
    console.log(`\nD = ${d} s\n\n| Class | Calls | M1 |\n| --- | --- | --- |`);
    for (const [group, label] of [['single-on-both', 'Single on both'], ['queued-on-both', 'Queued on both'], ['disputed', "Disputed (class differs with AT's arrival times)"]] as const) {
      console.log(`| ${label} | ${t[group].calls} | ${share(t[group])} |`);
    }
    console.log(`\nNot right: ${all.reduce((n, x) => n + x.wrong, 0)} on the wrong vehicle, ${all.reduce((n, x) => n + x.none, 0)} with no commit before the call.`);
  }
}
