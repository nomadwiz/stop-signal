// C7: decodes archived GTFS-Realtime snapshots and measures R1, how many vehicle records carry a
// trip_id in the timetable of the service days named (#20). `gtfs-realtime-bindings` is imported here and
// nowhere else outside tests (ADR-015 decision 3); hail-core never imports this module.
//
// Usage: node packages/hail-service/src/gtfs-realtime.ts <gtfs.zip> <YYYYMMDD[,YYYYMMDD…]> <archive root> <from-ms> <to-ms>
//   Reads every <root>/*/<epoch-ms>.pb.gz that capture wrote with from-ms <= epoch-ms < to-ms, and
//   matches each vehicle record's trip_id against the trips gtfs-static.ts keeps for any day named.
//   Name the day measured last, after the day before it, whose trips run past midnight: 20261002,20261003.
//   Prints A (matched / all records), B (matched / records with a trip_id), how many matched only
//   through a day before the last, and all three by NZ hour.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { loadServiceDay } from './gtfs-static.ts';

// earlierOnly: matched, but not through the last day named, such as a Friday trip seen on Saturday.
export interface Coverage { records: number; withTrip: number; matched: number; earlierOnly: number }
export interface Measured { snapshots: number; first: number; last: number; total: Coverage; byHour: Map<string, Coverage> }

// The snapshot's capture time decides its hour, not the vehicle's own timestamp.
// ponytail: keyed by hour alone, so a range over a day merges the same hour of two days; key by date too if one is ever wanted.
const nzHour = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', hourCycle: 'h23' });

export async function tripCoverage(root: string, from: number, to: number, days: Set<string>[]): Promise<Measured> {
  const last = days.at(-1);
  // Keyed by time, never by folder: folders are UTC dates and a New Zealand day spans two.
  const files = (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.pb.gz'))
    .map((path) => ({ path, at: Number(basename(path, '.pb.gz')) }))
    .filter(({ at }) => from <= at && at < to)
    .sort((a, b) => a.at - b.at);

  const total: Coverage = { records: 0, withTrip: 0, matched: 0, earlierOnly: 0 };
  const byHour = new Map<string, Coverage>();
  for (const { path, at } of files) {
    const hour = nzHour.format(at);
    let bucket = byHour.get(hour);
    if (!bucket) {
      bucket = { records: 0, withTrip: 0, matched: 0, earlierOnly: 0 };
      byHour.set(hour, bucket);
    }
    const feed = bindings.transit_realtime.FeedMessage.decode(gunzipSync(await readFile(join(root, path))));
    for (const entity of feed.entity) {
      if (!entity.vehicle) continue;
      // A missing trip_id decodes as '', so an empty one counts as absent.
      const tripId = entity.vehicle.trip?.tripId;
      const matched = !!tripId && days.some((day) => day.has(tripId));
      const earlierOnly = matched && !last?.has(tripId);
      for (const c of [total, bucket]) {
        c.records++;
        c.withTrip += Number(!!tripId);
        c.matched += Number(matched);
        c.earlierOnly += Number(earlierOnly);
      }
    }
  }
  return { snapshots: files.length, first: files[0]?.at ?? NaN, last: files.at(-1)?.at ?? NaN, total, byHour };
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
  // One day at a time, keeping only its trip_ids, so the heap never holds two whole indexes (B4).
  for (const day of names) {
    const { trips } = await loadServiceDay(zipPath, day);
    days.push(new Set(trips.keys()));
    console.log(`service day ${day}: ${trips.size} trips in the timetable`);
  }
  const m = await tripCoverage(root, Number(from), Number(to), days);
  if (!m.snapshots) {
    console.error(`no snapshots in [${from}, ${to}) under ${root}`);
    process.exit(1);
  }
  const { records, withTrip, matched, earlierOnly } = m.total;
  console.log(`${m.snapshots} snapshots, ${new Date(m.first).toISOString()} to ${new Date(m.last).toISOString()}`);
  console.log(`A = ${matched} / ${records} vehicle records = ${percent(matched, records)}`);
  console.log(`B = ${matched} / ${withTrip} records with a trip_id = ${percent(matched, withTrip)}`);
  console.log(`matched only through a day before ${names.at(-1)}: ${earlierOnly}`);
  console.log('\n| NZ hour | Records | With trip_id | Matched | Only an earlier day | A | B |\n| --- | --- | --- | --- | --- | --- | --- |');
  for (const [hour, c] of m.byHour) {
    console.log(`| ${hour} | ${c.records} | ${c.withTrip} | ${c.matched} | ${c.earlierOnly} | ${percent(c.matched, c.records)} | ${percent(c.matched, c.withTrip)} |`);
  }
}
