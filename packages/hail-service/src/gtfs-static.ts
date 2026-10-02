// C7: loads AT's GTFS static timetable for one service day into an in-memory index (#19, FR5).
// No dependency: zip entries are found through the central directory and inflated with node:zlib
// (ADR-015 decision 6). Only this module knows the wire format; hail-core never imports it.
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

export interface Stop { id: string; code: string; name: string; lat: number; lon: number }
export interface Route { id: string; shortName: string; type: number }
// Times are seconds after the service day's start, so 25:30:00 is 91800. Empty when not a timepoint.
export interface StopTime { stopId: string; sequence: number; arrival: number | undefined; departure: number | undefined }
export interface Trip { id: string; routeId: string; headsign: string; directionId: number; shapeId: string; stopTimes: StopTime[] }
export interface ShapePoint { lat: number; lon: number; sequence: number }

export interface StaticIndex {
  day: string;
  stops: Map<string, Stop>;
  routes: Map<string, Route>;
  trips: Map<string, Trip>;
  tripsAtStop: Map<string, string[]>;
  shapes: Map<string, ShapePoint[]>;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export async function loadServiceDay(zipPath: string, day: string): Promise<StaticIndex> {
  const date = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
  // The round trip also rejects 20260231, which Date.UTC would roll into March.
  if (!/^\d{8}$/.test(day) || date.toISOString().slice(0, 10).replaceAll('-', '') !== day) {
    throw new Error(`service day ${day} is not a YYYYMMDD date`);
  }
  const entries = await readCentralDirectory(zipPath);
  const rows = (name: string, columns: string[]) => readRows(zipPath, entries, name, columns);

  const weekday = WEEKDAYS[date.getUTCDay()];
  const running = new Set<string>();
  for await (const r of rows('calendar.txt', ['service_id', 'start_date', 'end_date', ...WEEKDAYS])) {
    if (r[weekday] === '1' && r.start_date <= day && day <= r.end_date) running.add(r.service_id);
  }
  for await (const r of rows('calendar_dates.txt', ['service_id', 'date', 'exception_type'])) {
    if (r.date !== day) continue;
    if (r.exception_type === '1') running.add(r.service_id);
    if (r.exception_type === '2') running.delete(r.service_id);
  }

  const stops = new Map<string, Stop>();
  for await (const r of rows('stops.txt', ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'])) {
    stops.set(r.stop_id, { id: r.stop_id, code: r.stop_code ?? '', name: r.stop_name, lat: +r.stop_lat, lon: +r.stop_lon });
  }
  const routes = new Map<string, Route>();
  for await (const r of rows('routes.txt', ['route_id', 'route_short_name', 'route_type'])) {
    routes.set(r.route_id, { id: r.route_id, shortName: r.route_short_name, type: +r.route_type });
  }
  const trips = new Map<string, Trip>();
  for await (const r of rows('trips.txt', ['route_id', 'service_id', 'trip_id'])) {
    if (!running.has(r.service_id)) continue;
    trips.set(r.trip_id, {
      id: r.trip_id, routeId: r.route_id, headsign: r.trip_headsign ?? '', directionId: +(r.direction_id ?? 0), shapeId: r.shape_id ?? '', stopTimes: [],
    });
  }
  for await (const r of rows('stop_times.txt', ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'])) {
    const trip = trips.get(r.trip_id);
    if (!trip) continue;
    // The stop's own id string, so a million stop times do not each hold a copy of a line.
    const stopId = stops.get(r.stop_id)?.id ?? r.stop_id;
    trip.stopTimes.push({ stopId, sequence: +r.stop_sequence, arrival: seconds(r.arrival_time), departure: seconds(r.departure_time) });
  }

  const tripsAtStop = new Map<string, string[]>();
  const shapeIds = new Set<string>();
  for (const trip of trips.values()) {
    trip.stopTimes.sort((a, b) => a.sequence - b.sequence);
    shapeIds.add(trip.shapeId);
    for (const { stopId } of trip.stopTimes) {
      const at = tripsAtStop.get(stopId) ?? tripsAtStop.set(stopId, []).get(stopId)!;
      // A loop route calls at its terminus twice; list the trip once.
      if (at.at(-1) !== trip.id) at.push(trip.id);
    }
  }

  const shapes = new Map<string, ShapePoint[]>();
  for await (const r of rows('shapes.txt', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) {
    if (!shapeIds.has(r.shape_id)) continue;
    const points = shapes.get(r.shape_id) ?? shapes.set(r.shape_id, []).get(r.shape_id)!;
    points.push({ lat: +r.shape_pt_lat, lon: +r.shape_pt_lon, sequence: +r.shape_pt_sequence });
  }
  for (const points of shapes.values()) points.sort((a, b) => a.sequence - b.sequence);

  return { day, stops, routes, trips, tripsAtStop, shapes };
}

function seconds(time: string | undefined): number | undefined {
  if (!time) return undefined;
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// Fields may be quoted, and a quote inside a quoted field is doubled: `"Eden Park ""Gate A"""`.
export function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') {
      quoted = !quoted;
    } else if (c === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  fields.push(field);
  return fields;
}

interface Entry { method: number; compressedSize: number; localHeader: number }

// ponytail: no ZIP64, no encryption, no line breaks inside quoted fields. AT's feed has none of
// them (checked 02-10-2026); each fails loudly here except the last, which needs a CSV reader
// that spans lines in place of readline.
async function readCentralDirectory(zipPath: string): Promise<Map<string, Entry>> {
  const file = await open(zipPath);
  try {
    const { size } = await file.stat();
    // The end-of-central-directory record is 22 bytes plus a comment of up to 65,535.
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await file.read(tail, 0, tailLength, size - tailLength);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`${zipPath} is not a zip`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(`${zipPath} is ZIP64, which this reader does not handle`);

    const cd = Buffer.alloc(cdSize);
    await file.read(cd, 0, cdSize, cdOffset);
    const entries = new Map<string, Entry>();
    for (let p = 0, i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${zipPath} has a corrupt central directory`);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
    const size = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const localHeader = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
      if (flags & 1) throw new Error(`${name} in ${zipPath} is encrypted`);
      if (method !== 0 && method !== 8) throw new Error(`${name} in ${zipPath} uses compression method ${method}`);
      if (compressedSize === 0xffffffff || size === 0xffffffff || localHeader === 0xffffffff) throw new Error(`${name} in ${zipPath} is ZIP64`);
      // Sizes come from here, not the local header: AT's entries carry data descriptors, so theirs are zero.
      entries.set(name, { method, compressedSize, localHeader });
      p += 46 + nameLength + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32);
    }
    // The local header's name and extra lengths can differ from the central directory's.
    for (const entry of entries.values()) {
      const local = Buffer.alloc(30);
      await file.read(local, 0, 30, entry.localHeader);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`${zipPath} has a corrupt local header`);
      entry.localHeader += 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    }
    return entries;
  } finally {
    await file.close();
  }
}

// Yields each row as {column: value}. A missing optional file (calendar.txt, calendar_dates.txt,
// shapes.txt) yields nothing. A missing required file, an empty file, or a missing column the caller
// reads is an error, so a renamed column fails here rather than loading an empty day.
async function* readRows(zipPath: string, entries: Map<string, Entry>, name: string, columns: string[]): AsyncGenerator<Record<string, string>> {
  const entry = entries.get(name);
  if (!entry) {
    if (['calendar.txt', 'calendar_dates.txt', 'shapes.txt'].includes(name)) return;
    throw new Error(`${zipPath} has no ${name}`);
  }
  if (entry.compressedSize === 0) throw new Error(`${name} in ${zipPath} is empty`);
  const raw = createReadStream(zipPath, { start: entry.localHeader, end: entry.localHeader + entry.compressedSize - 1 });
  // The iteration below rejects on its input's error, and pipeline hands a read error on to the inflater.
  const input = entry.method === 8 ? pipeline(raw, createInflateRaw(), () => {}) : raw;
  try {
    let header: string[] | undefined;
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!header) {
        const names = parseCsvLine(line.replace(/^\uFEFF/, ''));
        const missing = columns.filter((c) => !names.includes(c));
        if (missing.length) throw new Error(`${name} in ${zipPath} lacks ${missing.join(', ')}`);
        header = names;
        continue;
      }
      if (!line) continue;
      const fields = parseCsvLine(line);
      const row: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) row[header[i]] = fields[i] ?? '';
      yield row;
    }
    if (!header) throw new Error(`${name} in ${zipPath} is empty`);
  } finally {
    // Releases the file when the loop ends early, as it does on a missing column.
    raw.destroy();
  }
}
