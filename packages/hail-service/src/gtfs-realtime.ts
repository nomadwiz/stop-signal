// C7: decodes archived GTFS-Realtime snapshots and measures R1, how many vehicle records carry a
// trip_id in that service day's timetable (#20). `gtfs-realtime-bindings` is imported here and
// nowhere else outside tests (ADR-015 decision 3); hail-core never imports this module.
//
// Usage: node packages/hail-service/src/gtfs-realtime.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms>
//   Reads every <root>/*/<epoch-ms>.pb.gz that capture wrote with from-ms <= epoch-ms < to-ms, and
//   matches each vehicle record's trip_id against the trips gtfs-static.ts keeps for YYYYMMDD.
//   Prints A (matched / all records), B (matched / records with a trip_id) and both by NZ hour.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { loadServiceDay } from './gtfs-static.ts';

export interface Coverage { records: number; withTrip: number; matched: number }
export interface Measured { snapshots: number; first: number; last: number; total: Coverage; byHour: Map<string, Coverage> }

// The snapshot's capture time decides its hour, not the vehicle's own timestamp.
// ponytail: keyed by hour alone, so a range over a day merges the same hour of two days; key by date too if one is ever wanted.
const nzHour = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', hourCycle: 'h23' });

export async function tripCoverage(root: string, from: number, to: number, trips: { has(id: string): boolean }): Promise<Measured> {
  // Keyed by time, never by folder: folders are UTC dates and a New Zealand day spans two.
  const files = (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.pb.gz'))
    .map((path) => ({ path, at: Number(basename(path, '.pb.gz')) }))
    .filter(({ at }) => from <= at && at < to)
    .sort((a, b) => a.at - b.at);

  const total: Coverage = { records: 0, withTrip: 0, matched: 0 };
  const byHour = new Map<string, Coverage>();
  for (const { path, at } of files) {
    const hour = nzHour.format(at);
    const bucket = byHour.get(hour) ?? byHour.set(hour, { records: 0, withTrip: 0, matched: 0 }).get(hour)!;
    const feed = bindings.transit_realtime.FeedMessage.decode(gunzipSync(await readFile(join(root, path))));
    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;
      // A missing trip_id decodes as '', so an empty one counts as absent.
      const tripId = entity.vehicle.trip?.tripId;
      const matched = Number(!!tripId && trips.has(tripId));
      for (const c of [total, bucket]) {
        c.records++;
        c.withTrip += Number(!!tripId);
        c.matched += matched;
      }
    }
  }
  return { snapshots: files.length, first: files[0]?.at ?? NaN, last: files.at(-1)?.at ?? NaN, total, byHour };
}

const percent = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1)}%`;

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to) {
    console.error('Usage: node packages/hail-service/src/gtfs-realtime.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms>');
    process.exit(1);
  }
  const { trips } = await loadServiceDay(zipPath, day);
  const m = await tripCoverage(root, Number(from), Number(to), trips);
  if (!m.snapshots) {
    console.error(`no snapshots in [${from}, ${to}) under ${root}`);
    process.exit(1);
  }
  const { records, withTrip, matched } = m.total;
  console.log(`service day ${day}: ${trips.size} trips in the timetable`);
  console.log(`${m.snapshots} snapshots, ${new Date(m.first).toISOString()} to ${new Date(m.last).toISOString()}`);
  console.log(`A = ${matched} / ${records} vehicle records = ${percent(matched, records)}`);
  console.log(`B = ${matched} / ${withTrip} records with a trip_id = ${percent(matched, withTrip)}`);
  console.log('\n| NZ hour | Records | With trip_id | Matched | A | B |\n| --- | --- | --- | --- | --- | --- |');
  for (const [hour, c] of m.byHour) {
    console.log(`| ${hour} | ${c.records} | ${c.withTrip} | ${c.matched} | ${percent(c.matched, c.records)} | ${percent(c.matched, c.withTrip)} |`);
  }
}
