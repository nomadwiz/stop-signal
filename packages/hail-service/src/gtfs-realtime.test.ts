import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import { tripCoverage } from './gtfs-realtime.ts';

const { FeedMessage } = bindings.transit_realtime;
const TRIPS = new Set(['T1']);
// 00:00 NZDT on Saturday 03-10-2026, which is 11:00 UTC on 02-10-2026.
const SATURDAY = 1790938800000;
const HOUR = 3_600_000;

// One snapshot, as capture archives it: a gzipped FeedMessage at <root>/<UTC date>/<epoch-ms>.pb.gz.
async function snapshot(root: string, at: number, entity: object[]): Promise<void> {
  const dir = join(root, new Date(at).toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  const bytes = FeedMessage.encode(FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0' }, entity })).finish();
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

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, TRIPS);

    expect(result.snapshots).toBe(1);
    expect(result.total).toEqual({ records: 4, withTrip: 2, matched: 1 });
  });

  it('takes snapshots by key range across UTC folders, and splits them by hour of New Zealand time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rt-'));
    await snapshot(root, SATURDAY - 1, [vehicle('Friday', { tripId: 'T1' })]);
    await snapshot(root, SATURDAY, [vehicle('a', { tripId: 'T1' })]);
    // 13:00 UTC is in the next UTC folder, but still Saturday in New Zealand.
    await snapshot(root, SATURDAY + 13 * HOUR + 5, [vehicle('b', { tripId: 'T1' }), vehicle('c')]);
    await snapshot(root, SATURDAY + 24 * HOUR, [vehicle('Sunday', { tripId: 'T1' })]);
    // A write capture had not finished renaming.
    await writeFile(join(root, '2026-10-02', `${SATURDAY + 1}.pb.gz.tmp`), 'partial');

    const result = await tripCoverage(root, SATURDAY, SATURDAY + 24 * HOUR, TRIPS);

    expect(result.snapshots).toBe(2);
    expect(result.first).toBe(SATURDAY);
    expect(result.last).toBe(SATURDAY + 13 * HOUR + 5);
    expect(result.total).toEqual({ records: 3, withTrip: 2, matched: 2 });
    expect([...result.byHour]).toEqual([
      ['00', { records: 1, withTrip: 1, matched: 1 }],
      ['13', { records: 2, withTrip: 1, matched: 1 }],
    ]);
  });
});
