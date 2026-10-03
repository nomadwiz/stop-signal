// C7: derives after the fact when each vehicle actually called at each stop of its trip, from the
// archived vehicle positions alone (#14, S9, QR2). This is the correctness oracle the M1 measurement reads.
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import type { StaticIndex } from './gtfs-static.ts';

// Calibration value: how close a vehicle's path must come to a stop to count as calling there.
export const CALL_RADIUS_M = 50;

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

  const groups = new Map<string, Fix[]>();
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
      const key = `${tripId}|${index.day}|${vehicle.vehicle?.id ?? ''}`;
      const fixes = groups.get(key) ?? groups.set(key, []).get(key)!;
      fixes.push({ at, lat: vehicle.position.latitude, lon: vehicle.position.longitude });
    }
  }

  const calls: Call[] = [];
  for (const [key, fixes] of groups) {
    const [tripId, startDate, vehicleId] = key.split('|');
    for (const { stopId, stopSequence, at } of callsOf(index, tripId, fixes)) calls.push({ tripId, startDate, vehicleId, stopId, stopSequence, at });
  }
  calls.sort((a, b) => a.at - b.at || a.tripId.localeCompare(b.tripId) || a.stopSequence - b.stopSequence);
  return { calls, observed };
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

  // near[k][i]: where line i, from fix i to fix i + 1, comes closest to the trip's k-th stop.
  const stops = index.trips.get(tripId)!.stopTimes.flatMap(({ stopId, sequence }) => {
    const stop = index.stops.get(stopId);
    if (!stop) return [];
    const [sx, sy] = xy(stop.lat, stop.lon);
    return [{ stopId, sequence, near: points.slice(1).map((b, i) => closest(sx, sy, points[i], b)) }];
  });
  const within = (k: number, i: number) => i >= 0 && i < points.length - 1 && stops[k].near[i].d <= CALL_RADIUS_M;

  const found = [];
  let cursor = 0;
  for (const [k, { stopId, sequence, near }] of stops.entries()) {
    let start = cursor;
    while (start < near.length && !within(k, start)) start++;
    if (start === near.length) continue;
    // Skip-ahead guard: a stop missed on its own pass (a gap in the fixes) must not match where the vehicle passes
    // it again later, such as running back along the route still carrying the trip_id, because every stop after it
    // would then be searched for beyond that point. So the match must begin no later than the first line that
    // enters the radius of any later stop. A later stop already in range at the cursor is not entering it: that is
    // the stop just matched, or a loop's terminus seen again.
    let bound = Infinity;
    for (let m = k + 1; m < stops.length; m++) {
      for (let i = cursor + 1; i < bound; i++) {
        if (i >= near.length) break;
        if (within(m, i) && !within(m, i - 1)) bound = i;
      }
    }
    if (start > bound) continue;
    // Of the lines in that first stretch within the radius, the one passing nearest the stop: the first line in
    // range often grazes its edge while the vehicle stops on the next.
    let best = start;
    for (let i = start + 1; within(k, i); i++) if (near[i].d < near[best].d) best = i;
    found.push({ stopId, stopSequence: sequence, at: Math.round(fixes[best].at + near[best].f * (fixes[best + 1].at - fixes[best].at)) });
    cursor = best;
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
