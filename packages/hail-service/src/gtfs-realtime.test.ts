import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import type { StaticIndex, Trip } from './gtfs-static.ts';
import { predict } from '../../hail-core/src/predict.ts';
import { tripCoverage, tripsFromUpdates, vehicleReports } from './gtfs-realtime.ts';

const { FeedMessage } = bindings.transit_realtime;
// One service day's trip_ids, as the counter takes them.
const TRIPS = [new Set(['T1'])];
// 00:00 NZDT on Saturday 03-10-2026, which is 11:00 UTC on 02-10-2026.
const SATURDAY = 1790938800000;
const HOUR = 3_600_000;
const trip = (id: string): Trip => ({ id, routeId: 'R1', headsign: '', directionId: 0, shapeId: '', stopTimes: [] });
// Saturday's own trips, and Friday's T-late, which runs past midnight.
const INDEX: Pick<StaticIndex, 'trips' | 'lateTrips'> = { trips: new Map([['T1', trip('T1')], ['T2', trip('T2')]]), lateTrips: new Map([['T-late', trip('T-late')]]) };

// One snapshot, as capture archives it: a gzipped FeedMessage at <root>/<UTC date>/<epoch-ms>.pb.gz.
async function snapshot(root: string, at: number, entity: object[]): Promise<void> {
  const dir = join(root, new Date(at).toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const bytes = FeedMessage.encode(FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(at / 1000) }, entity })).finish();
  await writeFile(join(dir, `${at}.pb.gz`), gzipSync(bytes));
}

const vehicle = (id: string, trip?: object) => ({ id, vehicle: { vehicle: { id }, ...(trip && { trip }) } });

describe('tripCoverage', () => {
  it('counts vehicle records, those carrying a trip_id, and those whose trip_id is in the day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY + 9 * HOUR, [
      vehicle('matched', { tripId: 'T1' }),
      vehicle('unknown trip', { tripId: 'T9' }),
      vehicle('route only', { routeId: 'R1' }),
      vehicle('no trip'),
      // A trip update is not a vehicle record, though it carries a matching trip.
      { id: 'update', tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [] } },
    ]);

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, TRIPS, INDEX);

    expect(result.snapshots).toBe(1);
    expect(result.total).toEqual({ records: 4, withTrip: 2, matched: 1, earlierOnly: 0, recovered: 0 });
  });

  it('takes snapshots by key range across UTC folders, and splits them by hour of New Zealand time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY - 1, [vehicle('Friday', { tripId: 'T1' })]);
    await snapshot(root, SATURDAY, [vehicle('a', { tripId: 'T1' })]);
    // 00:00 UTC on 03-10-2026 is in the next UTC folder, but 13:00 NZDT, still Saturday in New Zealand.
    await snapshot(root, SATURDAY + 13 * HOUR + 5, [vehicle('b', { tripId: 'T1' }), vehicle('c')]);
    await snapshot(root, SATURDAY + 24 * HOUR, [vehicle('Sunday', { tripId: 'T1' })]);
    // A write capture had not finished renaming.
    await writeFile(join(root, '2026-10-02', `${SATURDAY + 1}.pb.gz.tmp`), 'partial');

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, TRIPS, INDEX);

    expect(result.snapshots).toBe(2);
    expect(result.first).toBe(SATURDAY);
    expect(result.last).toBe(SATURDAY + 13 * HOUR + 5);
    expect(result.total).toEqual({ records: 3, withTrip: 2, matched: 2, earlierOnly: 0, recovered: 0 });
    expect([...result.byHour]).toEqual([
      ['00', { records: 1, withTrip: 1, matched: 1, earlierOnly: 0, recovered: 0 }],
      ['13', { records: 2, withTrip: 1, matched: 1, earlierOnly: 0, recovered: 0 }],
    ]);
  });

  // Friday's service day runs past midnight: its last trip ends at 28:00, 04:00 on Saturday.
  const FRIDAY = new Set(['F1', 'both']);
  const SATURDAY_TRIPS = new Set(['S1', 'both']);
  const overnight = [
    vehicle('Friday night', { tripId: 'F1' }),
    vehicle('Saturday', { tripId: 'S1' }),
    vehicle('in both days', { tripId: 'both' }),
    vehicle('in neither', { tripId: 'X1' }),
  ];

  it('matches a trip_id that is in any of the service days named', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY + HOUR / 2, overnight);

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, [FRIDAY, SATURDAY_TRIPS], INDEX);

    expect(result.total.matched).toBe(3);
  });

  it('counts the records matched only through a day before the last one named, overall and by hour', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY + HOUR / 2, overnight);
    // A stale Friday trip_id in the afternoon still matches, and this count is what shows it.
    await snapshot(root, SATURDAY + 15 * HOUR, [vehicle('stale', { tripId: 'F1' })]);

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, [FRIDAY, SATURDAY_TRIPS], INDEX);

    expect(result.total.earlierOnly).toBe(2);
    expect([...result.byHour].map(([hour, c]) => [hour, c.earlierOnly])).toEqual([['00', 1], ['15', 1]]);
  });
});

// A trip update naming a vehicle; observed at `at` (epoch s) unless uncertainty says it is a prediction.
const update = (vehicleId: string, tripId: string, at: number, uncertainty?: number) => ({
  id: `${tripId}@${vehicleId}`,
  tripUpdate: { trip: { tripId, startDate: '20261003' }, vehicle: { id: vehicleId }, stopTimeUpdate: [{ stopSequence: 1, departure: { time: at, uncertainty } }] },
});
const NOW = SATURDAY / 1000 + 9 * 3600;
// Encoded and decoded, as capture's snapshots are read.
const decoded = (entity: object[]) =>
  FeedMessage.decode(FeedMessage.encode(FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW }, entity })).finish());

describe('tripsFromUpdates', () => {
  it('takes the trip and start date of the one started trip update that names an untagged vehicle', () => {
    const feed = decoded([vehicle('v1'), update('v1', 'T1', NOW - 60)]);

    expect(tripsFromUpdates(feed, INDEX)).toEqual(new Map([['v1', { tripId: 'T1', startDate: '20261003' }]]));
  });

  it('counts a departure at the snapshot time itself as started', () => {
    const feed = decoded([vehicle('v1'), update('v1', 'T1', NOW)]);

    expect(tripsFromUpdates(feed, INDEX).get('v1')?.tripId).toBe('T1');
  });

  it('takes a trip from the previous day that runs past midnight, in lateTrips', () => {
    const feed = decoded([vehicle('v1'), update('v1', 'T-late', NOW - 60)]);

    expect(tripsFromUpdates(feed, INDEX).get('v1')?.tripId).toBe('T-late');
  });

  it('leaves out a vehicle named by two started trip updates, its previous trip beside its current one (ADR-024)', () => {
    const feed = decoded([vehicle('v1'), update('v1', 'T1', NOW - 3600), update('v1', 'T2', NOW - 60)]);

    expect(tripsFromUpdates(feed, INDEX).size).toBe(0);
  });

  it('leaves untagged a vehicle whose trip update has not started, is only predicted, or is not in the index, and one no trip update names', () => {
    const feed = decoded([
      vehicle('future'), update('future', 'T1', NOW + 60),
      vehicle('predicted'), update('predicted', 'T1', NOW - 60, 30),
      vehicle('unknown trip'), update('unknown trip', 'T9', NOW - 60),
      vehicle('unnamed'),
    ]);

    expect(tripsFromUpdates(feed, INDEX).size).toBe(0);
  });

  it('ignores a trip update not in the index when deciding whether a vehicle is named twice', () => {
    const feed = decoded([vehicle('v1'), update('v1', 'T9', NOW - 3600), update('v1', 'T1', NOW - 60)]);

    expect(tripsFromUpdates(feed, INDEX).get('v1')?.tripId).toBe('T1');
  });

  it('gives nothing for a vehicle whose record carries its own trip_id', () => {
    const feed = decoded([vehicle('v1', { tripId: 'T2' }), update('v1', 'T1', NOW - 60)]);

    expect(tripsFromUpdates(feed, INDEX).size).toBe(0);
  });
});

describe('tripCoverage, recovered', () => {
  it('counts the untagged records whose trip a trip update gives, overall and by hour', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY + 9 * HOUR, [vehicle('v1'), update('v1', 'T1', NOW - 60), vehicle('v2'), vehicle('v3', { tripId: 'T2' })]);

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, TRIPS, INDEX);

    expect(result.total.recovered).toBe(1);
    expect(result.byHour.get('09')?.recovered).toBe(1);
  });
});

// A trip descriptor for Saturday's run of T1, as a tagged record carries it.
const T1 = { tripId: 'T1', startDate: '20261003' };
// A vehicle record as AT sends it: a position, the instant the vehicle measured it (epoch s), and a trip descriptor
// carrying a route. Latitude and longitude are 32-bit floats on the wire, so these are values a float holds exactly.
const located = (id: string, trip?: object, at = NOW - 8, latitude = -36.875, longitude = 174.75) => ({
  id,
  vehicle: { vehicle: { id }, position: { latitude, longitude }, timestamp: at, ...(trip && { trip }) },
});

describe('vehicleReports', () => {
  it("keeps a tagged record's trip_id and start date, with its position and fix time in epoch ms, and drops its route (ADR-026)", () => {
    const feed = decoded([located('v1', { tripId: 'T2', startDate: '20261003', routeId: 'DEV-209' })]);

    const reports = vehicleReports(feed, INDEX);

    expect(reports).toEqual([{ vehicleId: 'v1', tripId: 'T2', startDate: '20261003', lat: -36.875, lon: 174.75, at: (NOW - 8) * 1000 }]);
    expect(reports[0]).not.toHaveProperty('routeId');
  });

  it('keeps a tagged trip_id the index does not hold, for the resolver to turn away', () => {
    const feed = decoded([located('v1', { tripId: 'T9', startDate: '20261003' })]);

    expect(vehicleReports(feed, INDEX).map((r) => r.tripId)).toEqual(['T9']);
  });

  it('gives an untagged record the trip and start date of the one started trip update that names it (ADR-019)', () => {
    const feed = decoded([located('v1'), update('v1', 'T1', NOW - 60)]);

    expect(vehicleReports(feed, INDEX)).toEqual([{ vehicleId: 'v1', tripId: 'T1', startDate: '20261003', lat: -36.875, lon: 174.75, at: (NOW - 8) * 1000 }]);
  });

  it('leaves out an untagged record that no started trip update names, or that two name (ADR-024)', () => {
    const feed = decoded([
      located('unnamed'),
      located('twice'), update('twice', 'T1', NOW - 3600), update('twice', 'T2', NOW - 60),
      located('route only', { routeId: 'DEV-209' }),
    ]);

    expect(vehicleReports(feed, INDEX)).toEqual([]);
  });

  it('keeps a tagged record with no start date, without one, for the resolver to turn away (ADR-025)', () => {
    const feed = decoded([located('v1', { tripId: 'T1' })]);

    expect(vehicleReports(feed, INDEX)[0].startDate).toBeUndefined();
  });

  it('leaves out a record with no vehicle id, position or fix time, which Figure 4.3 makes every report carry', () => {
    const feed = decoded([
      { id: 'no position', vehicle: { vehicle: { id: 'no position' }, timestamp: NOW, trip: T1 } },
      { id: 'no vehicle id', vehicle: { position: { latitude: -36.875, longitude: 174.75 }, timestamp: NOW, trip: T1 } },
      { id: 'no time', vehicle: { vehicle: { id: 'no time' }, position: { latitude: -36.875, longitude: 174.75 }, trip: T1 } },
    ]);

    expect(vehicleReports(feed, INDEX)).toEqual([]);
  });

  it("gives reports from two snapshots that predict takes as the vehicle's previous and latest fixes", () => {
    // 2^-9 degrees, about 217 m, north along a straight shape in 20 s.
    const earlier = vehicleReports(decoded([located('v1', T1, NOW - 20, -36.875)]), INDEX);
    const later = vehicleReports(decoded([located('v1', T1, NOW, -36.873046875)]), INDEX);

    const { speedMps } = predict([{ lat: -36.88, lon: 174.75 }, { lat: -36.86, lon: 174.75 }], { lat: -36.865, lon: 174.75 }, earlier[0], later[0], NOW * 1000);

    expect(speedMps).toBeCloseTo(10.86, 2);
  });
});
