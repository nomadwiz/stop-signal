// C7: turns each decoded GTFS-Realtime snapshot into the vehicle reports the resolver reads (#113).
// Also measures R1 over archived snapshots: how many vehicle records carry a trip_id in the timetable of
// the service days named (#20), and how many without one take their trip from a trip update (#23).
// `gtfs-realtime-bindings` is imported here and nowhere else outside tests (ADR-015 decision 3);
// hail-core never imports this module.
//
// Usage: node packages/hail-service/src/gtfs-realtime.ts <gtfs.zip> <YYYYMMDD[,YYYYMMDD…]> <archive root> <from-ms> <to-ms>
//   Reads every <root>/*/<epoch-ms>.pb.gz that capture wrote with from-ms <= epoch-ms < to-ms, and
//   matches each vehicle record's trip_id against the trips gtfs-static.ts keeps for any day named.
//   Name the day measured last, after the day before it, whose trips run past midnight: 20261002,20261003.
//   Prints A (matched / all records), B (matched / records with a trip_id), how many matched only
//   through a day before the last, how many without a trip_id tripsFromUpdates recovers against the
//   last day's index, and all four by NZ hour.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import bindings, { type transit_realtime } from 'gtfs-realtime-bindings';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';

// earlierOnly: matched, but not through the last day named, such as a Friday trip seen on Saturday.
// recovered: no trip_id, but tripsFromUpdates gives one.
export interface Coverage { records: number; withTrip: number; matched: number; earlierOnly: number; recovered: number }
export interface Measured { snapshots: number; first: number; last: number; total: Coverage; byHour: Map<string, Coverage> }

// The snapshot's capture time decides its hour, not the vehicle's own timestamp.
// ponytail: keyed by hour alone, so a range over a day merges the same hour of two days; key by date too if one is ever wanted.
const nzHour = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', hourCycle: 'h23' });

export async function tripCoverage(root: string, from: number, to: number, days: Set<string>[], index: Pick<StaticIndex, 'trips' | 'lateTrips'>): Promise<Measured> {
  const last = days.at(-1);
  // Keyed by time, never by folder: folders are UTC dates and a New Zealand day spans two.
  const files = (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.pb.gz'))
    .map((path) => ({ path, at: Number(basename(path, '.pb.gz')) }))
    .filter(({ at }) => from <= at && at < to)
    .sort((a, b) => a.at - b.at);

  const total: Coverage = { records: 0, withTrip: 0, matched: 0, earlierOnly: 0, recovered: 0 };
  const byHour = new Map<string, Coverage>();
  for (const { path, at } of files) {
    const hour = nzHour.format(at);
    let bucket = byHour.get(hour);
    if (!bucket) {
      bucket = { records: 0, withTrip: 0, matched: 0, earlierOnly: 0, recovered: 0 };
      byHour.set(hour, bucket);
    }
    const feed = bindings.transit_realtime.FeedMessage.decode(gunzipSync(await readFile(join(root, path))));
    const recovered = tripsFromUpdates(feed, index);
    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;
      // A missing trip_id decodes as '', so an empty one counts as absent.
      const tripId = entity.vehicle.trip?.tripId;
      const matched = !!tripId && days.some((day) => day.has(tripId));
      const earlierOnly = matched && !last?.has(tripId);
      const fromUpdate = !tripId && recovered.has(entity.vehicle.vehicle?.id ?? '');
      for (const c of [total, bucket]) {
        c.records++;
        c.withTrip += Number(!!tripId);
        c.matched += Number(matched);
        c.earlierOnly += Number(earlierOnly);
        c.recovered += Number(fromUpdate);
      }
    }
  }
  return { snapshots: files.length, first: files[0]?.at ?? NaN, last: files.at(-1)?.at ?? NaN, total, byHour };
}

// A trip as a trip update gives it; startDate is absent when the trip update carries none.
export interface TripFromUpdate { tripId: string; startDate?: string }

// For each vehicle record in feed without a trip_id, the trip of the one trip update in the same snapshot whose
// vehicle.id is that vehicle, whose trip is in the day's trips or the previous day's late trips, and which has
// started: an arrival or departure at or before the snapshot, with uncertainty 0 or absent (ADR-019, ADR-020).
// A vehicle that two or more such trip updates name, its previous trip beside its current one, is left out, as is
// one that none names: neither is a candidate (ADR-024). The resolver
// chooses which run of a trip_id in both maps the vehicle is on, by startDate (ADR-025).
export function tripsFromUpdates(feed: transit_realtime.FeedMessage, index: Pick<StaticIndex, 'trips' | 'lateTrips'>): Map<string, TripFromUpdate> {
  const made = Number(feed.header.timestamp);
  const named = new Map<string, TripFromUpdate[]>();
  for (const { tripUpdate } of feed.entity) {
    const vehicleId = tripUpdate?.vehicle?.id;
    const tripId = tripUpdate?.trip.tripId;
    if (!vehicleId || !tripId || !(index.trips.has(tripId) || index.lateTrips.has(tripId))) continue;
    // Unset fields decode as 0 and '', so an absent uncertainty is 0 and an absent start date is ''.
    const started = (tripUpdate.stopTimeUpdate ?? []).some((u) => [u.arrival, u.departure].some((ev) => ev && !ev.uncertainty && Number(ev.time) && Number(ev.time) <= made));
    if (!started) continue;
    const list = named.get(vehicleId) ?? named.set(vehicleId, []).get(vehicleId)!;
    list.push({ tripId, startDate: tripUpdate.trip.startDate || undefined });
  }
  const trips = new Map<string, TripFromUpdate>();
  for (const { vehicle } of feed.entity) {
    const vehicleId = vehicle?.vehicle?.id;
    const only = vehicleId ? named.get(vehicleId) : undefined;
    if (vehicleId && !vehicle.trip?.tripId && only?.length === 1) trips.set(vehicleId, only[0]);
  }
  return trips;
}

// C7's one way to read vehicles from a snapshot: a VehicleReport for each vehicle record whose trip is known (#113).
// A tagged record keeps its trip_id and start date, whether or not the index holds the trip: the resolver decides.
// An untagged one takes them from tripsFromUpdates, and is otherwise left out. at is the vehicle's own timestamp,
// when it measured its position, not the snapshot's. A record with no position or timestamp is left out, since
// Figure 4.3 makes both mandatory; Saturday 03-10-2026 had none such in 4,715,345. trip.routeId is dropped (ADR-026).
export function vehicleReports(feed: transit_realtime.FeedMessage, index: Pick<StaticIndex, 'trips' | 'lateTrips'>): VehicleReport[] {
  const recovered = tripsFromUpdates(feed, index);
  const reports: VehicleReport[] = [];
  for (const { vehicle } of feed.entity) {
    // A missing trip_id, start date or vehicle id decodes as '', and a missing timestamp as 0.
    const vehicleId = vehicle?.vehicle?.id ?? '';
    const at = Number(vehicle?.timestamp) * 1000;
    const trip = vehicle?.trip?.tripId ? { tripId: vehicle.trip.tripId, startDate: vehicle.trip.startDate || undefined } : recovered.get(vehicleId);
    if (!vehicle?.position || !at || !trip) continue;
    reports.push({ vehicleId, ...trip, lat: vehicle.position.latitude, lon: vehicle.position.longitude, at });
  }
  return reports;
}

const percent = (part: number, whole: number) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '—');

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, dayList, root, from, to] = process.argv.slice(2);
  if (!zipPath || !dayList || !root || !from || !to) {
    console.error('Usage: node packages/hail-service/src/gtfs-realtime.ts <gtfs.zip> <YYYYMMDD[,YYYYMMDD…]> <archive root> <from-ms> <to-ms>');
    process.exit(1);
  }
  const names = dayList.split(',');
  const days: Set<string>[] = [];
  // One day at a time, keeping only its trip_ids and the last day's index, so the heap never holds two whole indexes (B4).
  let index: StaticIndex | undefined;
  for (const day of names) {
    // Released before the next day loads, so the previous day's whole index is never held beside it.
    index = undefined;
    index = await loadServiceDay(zipPath, day);
    days.push(new Set(index.trips.keys()));
    console.log(`service day ${day}: ${index.trips.size} trips in the timetable, ${index.lateTrips.size} late trips from ${index.previousDay}`);
  }
  const m = await tripCoverage(root, Number(from), Number(to), days, index!);
  if (!m.snapshots) {
    console.error(`no snapshots in [${from}, ${to}) under ${root}`);
    process.exit(1);
  }
  const { records, withTrip, matched, earlierOnly, recovered } = m.total;
  console.log(`${m.snapshots} snapshots, ${new Date(m.first).toISOString()} to ${new Date(m.last).toISOString()}`);
  console.log(`A = ${matched} / ${records} vehicle records = ${percent(matched, records)}`);
  console.log(`B = ${matched} / ${withTrip} records with a trip_id = ${percent(matched, withTrip)}`);
  console.log(`matched only through a day before ${names.at(-1)}: ${earlierOnly}`);
  console.log(`no trip_id, recovered from a trip update against ${names.at(-1)}'s index: ${recovered} of ${records - withTrip}`);
  console.log('\n| NZ hour | Records | With trip_id | Matched | Only an earlier day | Recovered | A | B |\n| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [hour, c] of m.byHour) {
    console.log(`| ${hour} | ${c.records} | ${c.withTrip} | ${c.matched} | ${c.earlierOnly} | ${c.recovered} | ${percent(c.matched, c.records)} | ${percent(c.matched, c.withTrip)} |`);
  }
}
