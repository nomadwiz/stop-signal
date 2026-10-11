// Cuts the passenger app's bundled stop list, ios/StopSignal/stops.json, from a GTFS timetable (#54, ADR-043): every
// stop on the routes through one stop, each with the routes that pick up there and their usual headsign there. The
// Stops screen sorts and searches it on the device, so no location leaves the phone (QR8).
//
// Usage: node ios/cut-stops.ts <gtfs.zip> <stop_id>
//   node ios/cut-stops.ts packages/replay/fixtures/gtfs.zip 7177-4660a5ff
//   Writes ios/StopSignal/stops.json. Regenerate it from the timetable the service loads, whenever that timetable
//   changes, so the app offers only stop and route ids the service knows.
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipRows } from '../packages/hail-service/src/gtfs-static.ts';

type Row = Record<string, string>;
export interface Timetable { trips: Row[]; stopTimes: Row[]; routes: Row[]; stops: Row[] }

const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

// The stops on the routes that pick up at `through`, by stop id, each with those routes in route-number order, and the
// span of the kept stops' validity dates.
export function cutStops(timetable: Timetable, through: string) {
  const trips = new Map(timetable.trips.map((t) => [t.trip_id, t]));
  const calls = new Map<string, Row[]>();
  for (const st of timetable.stopTimes) {
    if (!calls.has(st.trip_id)) calls.set(st.trip_id, []);
    calls.get(st.trip_id)!.push(st);
  }
  // A trip picks up at every call but its last, and at none whose pickup_type is 1 (no pickup).
  const pickups = (tripCalls: Row[]) =>
    tripCalls.toSorted((a, b) => +a.stop_sequence - +b.stop_sequence).slice(0, -1).filter((st) => st.pickup_type !== '1');

  const routeIds = new Set([...calls].filter(([, c]) => pickups(c).some((st) => st.stop_id === through)).map(([id]) => trips.get(id)!.route_id));
  // Per stop, per route, how many departures carry each headsign.
  const headsigns = new Map<string, Map<string, Map<string, number>>>();
  for (const [tripId, tripCalls] of calls) {
    const trip = trips.get(tripId)!;
    if (!routeIds.has(trip.route_id)) continue;
    for (const st of pickups(tripCalls)) {
      const routes = headsigns.get(st.stop_id) ?? headsigns.set(st.stop_id, new Map()).get(st.stop_id)!;
      const counts = routes.get(trip.route_id) ?? routes.set(trip.route_id, new Map()).get(trip.route_id)!;
      counts.set(trip.trip_headsign, (counts.get(trip.trip_headsign) ?? 0) + 1);
    }
  }

  const shortNames = new Map(timetable.routes.map((r) => [r.route_id, r.route_short_name]));
  const kept = timetable.stops.filter((s) => headsigns.has(s.stop_id)).toSorted((a, b) => byNumber(a.stop_id, b.stop_id));
  const stops = kept.map((s) => ({
    id: s.stop_id,
    code: s.stop_code,
    name: s.stop_name,
    lat: +s.stop_lat,
    lon: +s.stop_lon,
    routes: [...headsigns.get(s.stop_id)!]
      .map(([id, counts]) => ({
        id,
        shortName: shortNames.get(id)!,
        // The headsign most departures from this stop carry; ties go to the first alphabetically.
        headsign: [...counts].toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))[0][0],
      }))
      .toSorted((a, b) => byNumber(a.shortName, b.shortName)),
  }));
  const from = kept.map((s) => s.start_date).toSorted()[0];
  const to = kept.map((s) => s.end_date).toSorted().at(-1);
  return { stops, routes: [...routeIds].map((id) => shortNames.get(id)!).toSorted(byNumber), from, to };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, through] = process.argv.slice(2);
  if (!zipPath || !through) {
    console.error('Usage: node ios/cut-stops.ts <gtfs.zip> <stop_id>');
    process.exit(1);
  }
  const rows = async (file: string) => {
    const all: Row[] = [];
    for await (const row of zipRows(zipPath, file)) all.push(row);
    return all;
  };
  const timetable = { trips: await rows('trips.txt'), stopTimes: await rows('stop_times.txt'), routes: await rows('routes.txt'), stops: await rows('stops.txt') };
  const { stops, routes, from, to } = cutStops(timetable, through);
  const source = `${zipPath}, stops valid ${from}–${to}`;
  // One stop per line, so a regenerated file diffs by stop.
  writeFileSync(new URL('StopSignal/stops.json', import.meta.url), `{"source":${JSON.stringify(source)},"stops":[\n${stops.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`);
  console.log(`${stops.length} stops on routes ${routes.join(', ')}`);
}
