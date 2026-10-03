// C7: derives after the fact when each vehicle actually called at each stop of its trip, from the
// archived vehicle positions alone (#14, S9, QR2). This is the correctness oracle the M1 measurement reads.
// AT's observed times from its trip updates are read only to check the calls against, never as the oracle.
//
// Usage: node packages/hail-service/src/actual-calls.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> [trip_id,…]
//   Reads every <root>/*/<epoch-ms>.pb.gz with from-ms <= epoch-ms < to-ms, for the trips of that one service day.
//   With no trip_ids, prints every call as JSON Lines: {tripId, startDate, vehicleId, stopId, stopSequence, at}.
//   With trip_ids, prints a markdown table of each stop's gap from AT's observed time, the shares within
//   20 s and 30 s, and every miss.
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';

// Calibration value: how close a vehicle's path must come to a stop to count as calling there.
export const CALL_RADIUS_M = 50;
// One capture poll: a call agrees with AT's observed time when within this.
export const TOLERANCE_MS = 20_000;

// at: epoch ms at which the vehicle reached the stop.
export interface Call { tripId: string; startDate: string; vehicleId: string; stopId: string; stopSequence: number; at: number }

// AT's own observed times at a stop, epoch ms, keyed `tripId|startDate|stopSequence`. Used only to check the calls against.
export interface Observed { arrival?: number; departure?: number }

interface Fix { at: number; lat: number; lon: number }

export async function actualCalls(index: StaticIndex, root: string, from: number, to: number): Promise<{ calls: Call[]; observed: Map<string, Observed> }> {
  // Keyed by time, never by folder: folders are UTC dates and a New Zealand day spans two.
  const files = (await readdir(root, { recursive: true }))
    .filter((path) => path.endsWith('.pb.gz'))
    .map((path) => ({ path, at: Number(basename(path, '.pb.gz')) }))
    .filter(({ at }) => from <= at && at < to)
    .sort((a, b) => a.at - b.at);

  // One trajectory per trip and vehicle; every trip kept has startDate === index.day.
  const groups = new Map<string, { tripId: string; vehicleId: string; fixes: Fix[] }>();
  const observed = new Map<string, Observed>();
  for (const { path } of files) {
    const feed = bindings.transit_realtime.FeedMessage.decode(gunzipSync(await readFile(join(root, path))));
    const made = Number(feed.header.timestamp);
    for (const { vehicle, tripUpdate } of feed.entity) {
      const trip = tripUpdate?.trip;
      if (trip?.tripId && trip.startDate === index.day && index.trips.has(trip.tripId)) {
        for (const update of tripUpdate!.stopTimeUpdate ?? []) {
          const key = `${trip.tripId}|${index.day}|${update.stopSequence}`;
          for (const kind of ['arrival', 'departure'] as const) {
            const ev = update[kind];
            // An observation, not a prediction: no uncertainty (unset decodes as 0) and not after the snapshot was made.
            // A later snapshot's replaces an earlier one's, because AT revises them.
            if (!ev || ev.uncertainty !== 0 || !Number(ev.time) || Number(ev.time) > made) continue;
            (observed.get(key) ?? observed.set(key, {}).get(key)!)[kind] = Number(ev.time) * 1000;
          }
        }
      }
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

  const calls: Call[] = [];
  for (const { tripId, vehicleId, fixes } of groups.values()) {
    for (const { stopId, stopSequence, at } of callsOf(index, tripId, fixes)) calls.push({ tripId, startDate: index.day, vehicleId, stopId, stopSequence, at });
  }
  calls.sort((a, b) => a.at - b.at || a.tripId.localeCompare(b.tripId) || a.stopSequence - b.stopSequence);
  return { calls, observed };
}

// gap: the call's time minus AT's observed time at that stop, ms; basis says which observed time.
export interface Gap extends Call { basis: 'arrival' | 'departure'; observed: number; gap: number }

// Checks the calls against AT's observed times: the arrival where AT recorded one, else the departure. Each trip's
// first stop is left out, since a vehicle waits there before its trip starts. neverFound lists, as observed's keys,
// the stops AT observed on a trip the vehicle was tracked on that no call was derived for.
export function agreement(calls: Call[], observed: Map<string, Observed>, toleranceMs: number, index: StaticIndex): { gaps: Gap[]; neverFound: string[]; share: number } {
  const first = (tripId: string) => index.trips.get(tripId)?.stopTimes[0]?.sequence;
  const gaps: Gap[] = [];
  const found = new Set<string>();
  const tracked = new Set<string>();
  for (const c of calls) {
    const key = `${c.tripId}|${c.startDate}|${c.stopSequence}`;
    found.add(key);
    tracked.add(`${c.tripId}|${c.startDate}`);
    const o = observed.get(key);
    const at = o?.arrival ?? o?.departure;
    if (at === undefined || c.stopSequence === first(c.tripId)) continue;
    gaps.push({ ...c, basis: o?.arrival === undefined ? 'departure' : 'arrival', observed: at, gap: c.at - at });
  }
  const neverFound = [...observed.keys()].filter((key) => {
    const [tripId, startDate, sequence] = key.split('|');
    return !found.has(key) && tracked.has(`${tripId}|${startDate}`) && Number(sequence) !== first(tripId);
  });
  const within = gaps.filter((g) => Math.abs(g.gap) <= toleranceMs).length;
  return { gaps, neverFound, share: gaps.length ? within / gaps.length : NaN };
}

const nzTime = new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fraction = (part: number, whole: number) => `${part} / ${whole} compared = ${whole ? ((100 * part) / whole).toFixed(1) : '—'}%`;
const seconds = (ms: number) => `${ms >= 0 ? '+' : ''}${(ms / 1000).toFixed(1)}`;

// A row of the report; at and gap are absent for a stop never found.
type Row = Omit<Gap, 'at' | 'gap'> & Partial<Pick<Gap, 'at' | 'gap'>>;

// The markdown the CLI prints for the trips named: a row per stop compared or never found, past each trip's first stop.
export function report(calls: Call[], observed: Map<string, Observed>, index: StaticIndex, tripIds: string[]): string {
  const named = new Set(tripIds);
  const mine = calls.filter((c) => named.has(c.tripId));
  const theirs = new Map([...observed].filter(([key]) => named.has(key.split('|')[0])));
  const { gaps, neverFound } = agreement(mine, theirs, TOLERANCE_MS, index);
  const rows: Row[] = [
    ...gaps,
    ...neverFound.map((key): Row => {
      const [tripId, startDate, sequence] = key.split('|');
      const stopSequence = Number(sequence);
      const o = theirs.get(key)!;
      const stopId = index.trips.get(tripId)?.stopTimes.find((st) => st.sequence === stopSequence)?.stopId ?? '?';
      return { tripId, startDate, vehicleId: '', stopId, stopSequence, observed: (o.arrival ?? o.departure)!, basis: o.arrival === undefined ? 'departure' : 'arrival' };
    }),
  ].sort((a, b) => tripIds.indexOf(a.tripId) - tripIds.indexOf(b.tripId) || a.stopSequence - b.stopSequence);

  const within = (ms: number) => gaps.filter((g) => Math.abs(g.gap) <= ms).length;
  const misses = rows.filter((r) => r.gap === undefined || Math.abs(r.gap) > TOLERANCE_MS);
  return [
    '| Trip | Seq | Stop | Derived (NZ) | Observed (NZ) | Basis | Gap (s) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.tripId} | ${r.stopSequence} | ${r.stopId} | ${r.at === undefined ? 'never found' : nzTime.format(r.at)} | ${nzTime.format(r.observed)} | ${r.basis} | ${r.gap === undefined ? '—' : seconds(r.gap)} |`),
    '',
    `Within 20 s: ${fraction(within(TOLERANCE_MS), gaps.length)}`,
    `Within 30 s: ${fraction(within(30_000), gaps.length)}`,
    `Never found: ${neverFound.length}`,
    '',
    'Misses beyond 20 s or never found:',
    ...misses.map((r) => `- ${r.tripId} seq ${r.stopSequence} (${r.stopId}): ${r.gap === undefined ? 'never found' : `${seconds(r.gap)} s against the observed ${r.basis}`}`),
  ].join('\n');
}

const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);

function callsOf(index: StaticIndex, tripId: string, unsorted: Fix[]): { stopId: string; stopSequence: number; at: number }[] {
  // A fix stays in the feed until the vehicle reports again, so successive snapshots repeat it.
  const fixes = unsorted.sort((a, b) => a.at - b.at).filter((f, i, all) => i === 0 || f.at !== all[i - 1].at);
  // ponytail: flat-earth metres about the first fix, good to well under a metre across a city; project onto the trip's shape (index.shapes) if one is ever needed.
  const lat0 = fixes[0].lat;
  const kx = M_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const xy = (lat: number, lon: number) => [(lon - fixes[0].lon) * kx, (lat - lat0) * M_PER_DEGREE];
  const points = fixes.map((f) => xy(f.lat, f.lon));

  // The first line, from one fix to the next, that passes within the radius decides the call, timed at its point
  // nearest the stop, and each stop is searched for from the line that matched the stop before it.
  // The line passing nearest the stop was measured on Friday 13:00–16:00 and rejected: 88.2% within 20 s against
  // 96.7%, and 80.3% at stops where AT gave an arrival time, because GPS jitter while the bus waits at the stop moves
  // the nearest fix to partway through the wait.
  // ponytail: forward-only, so a stop matched too far along leaves the stops after it behind the cursor; about 2,000
  // stops on Friday came within the radius only there. Bounding each match by where any later stop is first reached
  // was measured and rejected: a vehicle carries its next trip_id while finishing the previous trip, passing that
  // trip's later stops first, and never-found stops rose from 1,963 to 5,110. Upgrade: a window around each stop's
  // scheduled time, not yet evaluated.
  const found = [];
  let cursor = 0;
  for (const { stopId, sequence } of index.trips.get(tripId)!.stopTimes) {
    const stop = index.stops.get(stopId);
    if (!stop) continue;
    const [sx, sy] = xy(stop.lat, stop.lon);
    for (let i = cursor; i < points.length - 1; i++) {
      const { d, f } = closest(sx, sy, points[i], points[i + 1]);
      if (d > CALL_RADIUS_M) continue;
      found.push({ stopId, stopSequence: sequence, at: Math.round(fixes[i].at + f * (fixes[i + 1].at - fixes[i].at)) });
      cursor = i;
      break;
    }
  }
  return found;
}

// The distance from (x, y) to the line a→b, and how far along it, 0 to 1, the nearest point lies.
function closest(x: number, y: number, [ax, ay]: number[], [bx, by]: number[]): { d: number; f: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const f = length2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
  return { d: Math.hypot(ax + f * dx - x, ay + f * dy - y), f };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [zipPath, day, root, from, to, tripList] = process.argv.slice(2);
  if (!zipPath || !day || !root || !from || !to) {
    console.error('Usage: node packages/hail-service/src/actual-calls.ts <gtfs.zip> <YYYYMMDD> <archive root> <from-ms> <to-ms> [trip_id,…]');
    process.exit(1);
  }
  const index = await loadServiceDay(zipPath, day);
  const { calls, observed } = await actualCalls(index, root, Number(from), Number(to));
  if (tripList) console.log(report(calls, observed, index, tripList.split(',')));
  else for (const call of calls) console.log(JSON.stringify(call));
}
