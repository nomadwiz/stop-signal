import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import { actualCalls, agreement, report, type Call, type Observed } from './actual-calls.ts';
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

  it('times the call on the first line within 50 m, even where a later line passes nearer', async () => {
    // Approaching 40 m north of A, then swinging through 2.5 m from it between the second and third fix.
    const root = await drive('T-weekday', [[-100, 40, 'A', T], [0, 40, 'A', T + 20], [5, -40, 'A', T + 40], [5, -200, 'A', T + 60]]);

    const { calls } = await actualCalls(index, root, FROM, TO);

    expect(calls).toHaveLength(1);
    expect(Math.abs(calls[0].at - (T + 20) * 1000)).toBeLessThanOrEqual(1000);
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

describe('agreement', () => {
  const call = (tripId: string, stopSequence: number, at: number): Call => ({ tripId, startDate: DAY, vehicleId: 'V1', stopId: 'X', stopSequence, at });
  const observedAt = (entries: [string, number, Observed][]) => new Map(entries.map(([tripId, seq, o]) => [`${tripId}|${DAY}|${seq}`, o]));

  it('compares each call with the observed arrival, else the observed departure, and skips the first stop', () => {
    const calls = [call('T-weekday', 1, 1_000), call('T-weekday', 2, 50_000), call('T-weekday', 10, 90_000)];
    const observed = observedAt([
      ['T-weekday', 1, { arrival: 1_000 }],
      ['T-weekday', 2, { arrival: 45_000, departure: 60_000 }],
      ['T-weekday', 10, { departure: 120_000 }],
    ]);

    const { gaps } = agreement(calls, observed, 20_000, index);

    expect(gaps.map(({ stopSequence, basis, observed, gap }) => ({ stopSequence, basis, observed, gap }))).toEqual([
      { stopSequence: 2, basis: 'arrival', observed: 45_000, gap: 5_000 },
      { stopSequence: 10, basis: 'departure', observed: 120_000, gap: -30_000 },
    ]);
  });

  it('gives the share of compared stops within the tolerance, inclusive', () => {
    const calls = [call('T-weekday', 2, 20_000), call('T-weekday', 10, 100_000), call('T-event', 2, 0), call('T-event', 3, 0)];
    const observed = observedAt([
      ['T-weekday', 2, { arrival: 0 }],
      ['T-weekday', 10, { arrival: 120_001 }],
      ['T-event', 2, { arrival: -19_000 }],
    ]);

    const { gaps, share } = agreement(calls, observed, 20_000, index);

    expect(gaps).toHaveLength(3);
    expect(share).toBeCloseTo(2 / 3);
  });

  it("lists the observed stops no call was found for, on trips the vehicle was tracked on, past the first stop", () => {
    const calls = [call('T-weekday', 2, 0)];
    const observed = observedAt([
      ['T-weekday', 1, { departure: 0 }],
      ['T-weekday', 2, { arrival: 0 }],
      ['T-weekday', 10, { arrival: 0 }],
      // No vehicle positions for this trip at all, so nothing was searched for.
      ['T-event', 2, { arrival: 0 }],
    ]);

    const { neverFound } = agreement(calls, observed, 20_000, index);

    expect(neverFound).toEqual([`T-weekday|${DAY}|10`]);
  });
});

describe('report', () => {
  // 07:12:30 NZDT on 05-10-2026, T-weekday's timetabled call at B.
  const B_AT = Date.UTC(2026, 9, 4, 18, 12, 30);
  const call = (stopId: string, stopSequence: number, at: number): Call => ({ tripId: 'T-weekday', startDate: DAY, vehicleId: 'V1', stopId, stopSequence, at });

  it('tables each stop of the trips named, gives the shares within 20 s and 30 s, and lists every miss', () => {
    const calls = [call('A', 1, B_AT - 750_000), call('B', 2, B_AT + 25_000)];
    const observed = new Map<string, Observed>([
      [`T-weekday|${DAY}|1`, { departure: B_AT - 750_000 }],
      [`T-weekday|${DAY}|2`, { arrival: B_AT }],
      [`T-weekday|${DAY}|10`, { departure: B_AT + 1_200_000 }],
    ]);

    expect(report(calls, observed, index, ['T-weekday']).split('\n')).toEqual([
      '| Trip | Seq | Stop | Derived (NZ) | Observed (NZ) | Basis | Gap (s) |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      '| T-weekday | 2 | B | 07:12:55 | 07:12:30 | arrival | +25.0 |',
      '| T-weekday | 10 | C | never found | 07:32:30 | departure | — |',
      '',
      'Within 20 s: 0 / 1 compared = 0.0%',
      'Within 30 s: 1 / 1 compared = 100.0%',
      'Never found: 1',
      '',
      'Misses beyond 20 s or never found:',
      '- T-weekday seq 2 (B): +25.0 s against the observed arrival',
      '- T-weekday seq 10 (C): never found',
    ]);
  });
});
