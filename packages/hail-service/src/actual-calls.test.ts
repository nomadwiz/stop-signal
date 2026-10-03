import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import { actualCalls } from './actual-calls.ts';
import { loadServiceDay } from './gtfs-static.ts';

const { FeedMessage } = bindings.transit_realtime;
// T-weekday calls at A(1), B(2), C(10); T-event at B(1), A(2), B(3). T-weekend does not run on this Monday.
const index = await loadServiceDay(fileURLToPath(new URL('../fixtures/gtfs.zip', import.meta.url)), '20261005');
const DAY = '20261005';
// Seconds, as vehicle.timestamp carries them.
const T = 1_790_000_000;
const FROM = (T - 3600) * 1000;
const TO = (T + 3600) * 1000;

// One snapshot, as capture archives it: a gzipped FeedMessage at <root>/<UTC date>/<epoch-ms>.pb.gz.
async function snapshot(root: string, at: number, entity: object[]): Promise<void> {
  const dir = join(root, new Date(at).toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const header = { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(at / 1000) };
  const bytes = FeedMessage.encode(FeedMessage.fromObject({ header, entity })).finish();
  await writeFile(join(dir, `${at}.pb.gz`), gzipSync(bytes));
}

// A point east and north of a stop by the metres given.
function near(stopId: string, east: number, north: number): { latitude: number; longitude: number } {
  const stop = index.stops.get(stopId)!;
  const perDegree = 111_195;
  return { latitude: stop.lat + north / perDegree, longitude: stop.lon + east / (perDegree * Math.cos((stop.lat * Math.PI) / 180)) };
}

type Fix = [east: number, north: number, stopId: string, seconds: number];
const fix = (tripId: string, [east, north, stopId, seconds]: Fix, extra: { startDate?: string; vehicleId?: string } = {}) => ({
  id: extra.vehicleId ?? 'V1',
  vehicle: {
    trip: { tripId, startDate: extra.startDate ?? DAY },
    vehicle: { id: extra.vehicleId ?? 'V1' },
    position: near(stopId, east, north),
    timestamp: seconds,
  },
});

// Each fix in its own snapshot, captured five seconds after the vehicle reported it.
async function drive(tripId: string, fixes: Fix[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'calls-'));
  for (const f of fixes) await snapshot(root, (f[3] + 5) * 1000, [fix(tripId, f)]);
  return root;
}

const seqs = (calls: { stopSequence: number }[]) => calls.map((c) => c.stopSequence);

describe('actualCalls', () => {
  it('times the call where the line between two fixes passes the stop', async () => {
    const root = await drive('T-weekday', [[-100, 0, 'A', T], [100, 0, 'A', T + 20]]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tripId: 'T-weekday', startDate: DAY, vehicleId: 'V1', stopId: 'A', stopSequence: 1 });
    expect(Math.abs(calls[0].at - (T + 10) * 1000)).toBeLessThanOrEqual(1000);
  });

  it('records no call at a stop the trajectory never comes within 50 m of', async () => {
    const root = await drive('T-weekday', [
      [-100, 0, 'A', T], [100, 0, 'A', T + 20],
      [-100, 0, 'B', T + 600], [100, 0, 'B', T + 620],
      [-100, 200, 'C', T + 1200], [100, 200, 'C', T + 1220],
    ]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(seqs(calls)).toEqual([1, 2]);
  });

  it('records both calls of a loop trip at its repeated stop, in time order', async () => {
    const root = await drive('T-event', [
      [-100, 0, 'B', T], [100, 0, 'B', T + 20],
      [-100, 0, 'A', T + 600], [100, 0, 'A', T + 620],
      [100, 0, 'B', T + 1200], [-100, 0, 'B', T + 1220],
    ]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls.map((c) => [c.stopId, c.stopSequence])).toEqual([['B', 1], ['A', 2], ['B', 3]]);
    expect(calls[0].at).toBeLessThan(calls[2].at);
  });

  it('ignores a record with no trip_id, no position, a trip not running that day, or another start date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    const pass: Fix[] = [[-100, 0, 'A', T], [100, 0, 'A', T + 20]];
    for (const [i, f] of pass.entries()) {
      const noPosition = fix('T-weekday', f, { vehicleId: 'no position' });
      delete (noPosition.vehicle as { position?: object }).position;
      await snapshot(root, (T + 5 + 20 * i) * 1000, [
        fix('', f, { vehicleId: 'no trip' }),
        noPosition,
        fix('T-weekend', f, { vehicleId: 'not today' }),
        fix('T-weekday', f, { vehicleId: 'tomorrow', startDate: '20261006' }),
      ]);
    }

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls).toEqual([]);
  });

  it("uses the vehicle's own timestamp, reads a fix repeated across snapshots once, and reads no snapshot outside the range", async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    const before = fix('T-weekday', [-100, 0, 'A', T]);
    const after = fix('T-weekday', [100, 0, 'A', T + 20]);
    await snapshot(root, (T + 15) * 1000, [before]);
    await snapshot(root, (T + 35) * 1000, [after]);
    await snapshot(root, (T + 55) * 1000, [after]);
    // Either side of the range, and not a snapshot at all: reading it would throw.
    await mkdir(join(root, 'edges'));
    await writeFile(join(root, 'edges', `${FROM - 1}.pb.gz`), 'not gzip');
    await writeFile(join(root, 'edges', `${TO}.pb.gz`), 'not gzip');

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls).toHaveLength(1);
    expect(Math.abs(calls[0].at - (T + 10) * 1000)).toBeLessThanOrEqual(1000);
  });

  it('times the call on the line nearest the stop, not the first line within 50 m', async () => {
    // Approaching 40 m north of A, then swinging through 2.5 m from it halfway between the second and third fix.
    const root = await drive('T-weekday', [[-100, 40, 'A', T], [0, 40, 'A', T + 20], [5, -40, 'A', T + 40], [5, -200, 'A', T + 60]]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls).toHaveLength(1);
    expect(Math.abs(calls[0].at - (T + 30) * 1000)).toBeLessThanOrEqual(1000);
  });

  it('does not match a stop past where a later stop is reached, so the later stops are still found', async () => {
    // A is missed by 80 m on the way out; the vehicle then passes B and C and returns past A with the same trip_id.
    const root = await drive('T-weekday', [
      [-100, 80, 'A', T], [100, 80, 'A', T + 20],
      [-100, 0, 'B', T + 600], [100, 0, 'B', T + 620],
      [-100, 0, 'C', T + 1200], [100, 0, 'C', T + 1220],
      [100, 0, 'A', T + 2400], [-100, 0, 'A', T + 2420],
    ]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(seqs(calls)).toEqual([2, 10]);
  });

  it('keeps vehicles on the same trip apart, and sorts the calls by time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    await snapshot(root, (T + 5) * 1000, [fix('T-weekday', [-100, 0, 'B', T]), fix('T-weekday', [-100, 0, 'A', T - 60], { vehicleId: 'V2' })]);
    await snapshot(root, (T + 25) * 1000, [fix('T-weekday', [100, 0, 'B', T + 20]), fix('T-weekday', [100, 0, 'A', T - 40], { vehicleId: 'V2' })]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls.map((c) => [c.vehicleId, c.stopId])).toEqual([['V2', 'A'], ['V1', 'B']]);
  });
});

describe("actualCalls' observed events", () => {
  // A trip update for one stop, its times in seconds. Unset uncertainty decodes as 0, as AT's observations do.
  const update = (stopSequence: number, arrival?: object, departure?: object) => ({
    id: `update ${stopSequence}`,
    tripUpdate: { trip: { tripId: 'T-weekday', startDate: DAY }, stopTimeUpdate: [{ stopSequence, ...(arrival && { arrival }), ...(departure && { departure }) }] },
  });
  const key = (stopSequence: number) => `T-weekday|${DAY}|${stopSequence}`;

  it('keeps arrival and departure apart, each in epoch ms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    await snapshot(root, (T + 100) * 1000, [update(2, { time: T }, { time: T + 30 }), update(10, undefined, { time: T + 50 })]);

    const { observed } = await actualCalls(index, root, FROM, TO);

    expect(observed.get(key(2))).toEqual({ arrival: T * 1000, departure: (T + 30) * 1000 });
    expect(observed.get(key(10))).toEqual({ departure: (T + 50) * 1000 });
  });

  it("takes a later snapshot's observation over an earlier one's, as AT revises them", async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    await snapshot(root, (T + 100) * 1000, [update(2, { time: T })]);
    await snapshot(root, (T + 120) * 1000, [update(2, { time: T + 8 })]);

    const { observed } = await actualCalls(index, root, FROM, TO);

    expect(observed.get(key(2))).toEqual({ arrival: (T + 8) * 1000 });
  });

  it('ignores a prediction: a time carrying uncertainty, or one after the snapshot was made', async () => {
    const root = await mkdtemp(join(tmpdir(), 'calls-'));
    await snapshot(root, (T + 100) * 1000, [update(2, { time: T, uncertainty: 30 }), update(10, { time: T + 101 })]);

    const { observed } = await actualCalls(index, root, FROM, TO);

    expect(observed.size).toBe(0);
  });
});
