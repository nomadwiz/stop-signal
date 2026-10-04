// C7: cuts a window of archived snapshots, and the timetable, to one stop's corridor, as CI's replay fixtures (#13, ADR-030).
// CI holds no AWS credentials (ADR-014), so the fixtures are committed and this script is run by hand.
//
// Usage, with AWS credentials, once per UTC date folder the window touches:
//   aws s3 sync s3://stopsignal-archive-995583236543/raw/<UTC date>/ <archive root>/<UTC date>/
// then:
//   node packages/hail-service/src/cut-fixtures.ts <gtfs.zip> <YYYYMMDD> <stop_id> <archive root> <from-ms> <to-ms>
//   Cuts every <root>/<UTC date>/<epoch-ms>.pb.gz with from-ms <= epoch-ms < to-ms to the trips that call at stop_id that
//   service day (cutFeed), and the timetable to those trips and every trip a kept trip update names (timetableTrips,
//   cutTimetable), then writes packages/replay/fixtures/:
//   snapshots/<epoch-ms>.pb.gz, gtfs.zip, and manifest.json naming each source object's S3 key, size, SHA-256 and MD5.
//   <archive root> must be a copy of raw/ as synced: the manifest is what the owner checks against S3.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import bindings, { type transit_realtime } from 'gtfs-realtime-bindings';
import { GTFS_URL, loadServiceDay, zipRows } from './gtfs-static.ts';

const { FeedMessage } = bindings.transit_realtime;
export const BUCKET = 'stopsignal-archive-995583236543';
export const CUT_RULE = "Every trip update whose trip calls at the stop; every vehicle whose trip calls at the stop or that one of those trip updates names; and every other trip update that names a kept vehicle (ADR-030).";

// The feed cut to trips, keeping what the resolver, the trip-update join (ADR-019, ADR-024) and the oracle read for the
// stop, in the feed's own order. Trip updates naming a kept vehicle stay whatever their trip, so ADR-024 sees every name.
export function cutFeed(feed: transit_realtime.FeedMessage, trips: Set<string>): transit_realtime.FeedMessage {
  // A missing vehicle id decodes as '', which names no vehicle.
  const ids = (vehicles: (transit_realtime.IVehicleDescriptor | null | undefined)[]) => new Set(vehicles.map((v) => v?.id).filter((v) => !!v));
  const named = ids(feed.entity.filter((e) => trips.has(e.tripUpdate?.trip.tripId ?? '')).map((e) => e.tripUpdate!.vehicle));
  const vehicles = new Set(feed.entity.filter((e) => e.vehicle && (trips.has(e.vehicle.trip?.tripId ?? '') || named.has(e.vehicle.vehicle?.id ?? ''))));
  const kept = ids([...vehicles].map((e) => e.vehicle!.vehicle));
  const entity = feed.entity.filter((e) => vehicles.has(e) || (e.tripUpdate && (trips.has(e.tripUpdate.trip.tripId ?? '') || kept.has(e.tripUpdate.vehicle?.id ?? ''))));
  return FeedMessage.create({ header: feed.header, entity });
}

// The corridor's trips and every trip a kept trip update names. The trip-update join counts an update only if its trip
// is in the timetable, so without the named trips it would recover vehicles that ADR-024 leaves out (ADR-030).
export function timetableTrips(trips: Set<string>, cuts: transit_realtime.FeedMessage[]): Set<string> {
  const all = new Set(trips);
  for (const cut of cuts) for (const e of cut.entity) if (e.tripUpdate?.trip.tripId) all.add(e.tripUpdate.trip.tripId);
  return all;
}

// The files loadServiceDay reads, in the order each one's keys come from the files before it.
const KEYS: [file: string, column: string][] = [
  ['trips.txt', 'trip_id'], ['stop_times.txt', 'trip_id'], ['shapes.txt', 'shape_id'], ['routes.txt', 'route_id'],
  ['stops.txt', 'stop_id'], ['calendar.txt', 'service_id'], ['calendar_dates.txt', 'service_id'],
];

// The timetable at zipPath cut to trips and the shapes, routes, stops and services they use, as a zip loadServiceDay reads.
export async function cutTimetable(zipPath: string, trips: Set<string>): Promise<Buffer> {
  const keep: Record<string, Set<string>> = { trip_id: trips, shape_id: new Set(), route_id: new Set(), stop_id: new Set(), service_id: new Set() };
  const files: [string, string][] = [];
  for (const [file, column] of KEYS) {
    let header: string[] = [];
    const lines: string[] = [];
    for await (const row of zipRows(zipPath, file)) {
      if (!header.length) header = Object.keys(row);
      if (!keep[column].has(row[column])) continue;
      if (file === 'trips.txt') for (const c of ['shape_id', 'route_id', 'service_id']) keep[c].add(row[c]);
      if (file === 'stop_times.txt') keep.stop_id.add(row.stop_id);
      lines.push(csv(Object.values(row)));
    }
    files.push([file, [csv(header), ...lines, ''].join('\n')]);
  }
  return zip(files);
}

const csv = (fields: string[]) => fields.map((f) => (/[",]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(',');

// A deflated zip with every timestamp at 01-01-1980, so the same files give the same bytes.
function zip(files: [string, string][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [file, text] of files) {
    const name = Buffer.from(file);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(entry, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const hash = (algorithm: string, bytes: Buffer) => createHash(algorithm).update(bytes).digest('hex');

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, stopId, root, from, to] = process.argv.slice(2);
  if (!zipPath || !day || !stopId || !root || !(Number(from) > 0) || !(Number(to) > Number(from))) {
    console.error('Usage: node packages/hail-service/src/cut-fixtures.ts <gtfs.zip> <YYYYMMDD> <stop_id> <archive root> <from-ms> <to-ms>');
    process.exit(1);
  }
  const index = await loadServiceDay(zipPath, day);
  const trips = new Set(index.tripsAtStop.get(stopId));
  if (!trips.size) {
    console.error(`no trip calls at ${stopId} on ${day}`);
    process.exit(1);
  }
  const out = fileURLToPath(new URL('../../replay/fixtures/', import.meta.url));
  await rm(join(out, 'snapshots'), { recursive: true, force: true });
  await mkdir(join(out, 'snapshots'), { recursive: true });

  // Keyed by time, never by folder: folders are UTC dates and a New Zealand day spans two.
  const paths = (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.pb.gz') && Number(from) <= Number(basename(path, '.pb.gz')) && Number(basename(path, '.pb.gz')) < Number(to))
    .sort((a, b) => Number(basename(a, '.pb.gz')) - Number(basename(b, '.pb.gz')));
  const objects = [];
  const cuts = [];
  let bytes = 0;
  for (const path of paths) {
    const source = await readFile(join(root, path));
    const feed = cutFeed(FeedMessage.decode(gunzipSync(source)), trips);
    cuts.push(feed);
    const cut = gzipSync(FeedMessage.encode(feed).finish());
    const fixture = `snapshots/${basename(path)}`;
    await writeFile(join(out, fixture), cut);
    bytes += cut.length;
    objects.push({ key: `raw/${path.split('\\').join('/')}`, size: source.length, sha256: hash('sha256', source), md5: hash('md5', source), fixture, fixtureSha256: hash('sha256', cut) });
  }
  const kept = timetableTrips(trips, cuts);
  const timetable = await cutTimetable(zipPath, kept);
  await writeFile(join(out, 'gtfs.zip'), timetable);
  bytes += timetable.length;
  const manifest = {
    bucket: BUCKET, stopId, day, from: Number(from), to: Number(to), cut: CUT_RULE, objects,
    timetable: {
      source: GTFS_URL, sha256: hash('sha256', await readFile(zipPath)),
      trips: `Every trip in tripsAtStop(${stopId}) for ${day}, the previous day's late trips included, and every trip a kept trip update names, with the shapes, routes, stops and services they use.`,
      fixture: 'gtfs.zip', fixtureSha256: hash('sha256', timetable),
    },
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${objects.length} snapshots and the timetable (${kept.size} trips): ${bytes} bytes in ${out}`);
}
