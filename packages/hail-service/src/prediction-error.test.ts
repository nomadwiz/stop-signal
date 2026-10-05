import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import { loadServiceDay } from './gtfs-static.ts';
import { predictionErrors, report, trackErrors, type Track } from './prediction-error.ts';

// Points a given number of metres north of a fixed origin in Auckland, along a straight 2 km shape.
const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);
const north = (m: number) => ({ lat: -36.85 + m / M_PER_DEGREE, lon: 174.76 });
const shape = [north(0), north(2_000)];
// A fix m metres along the shape at s seconds.
const fix = (m: number, s: number) => ({ ...north(m), at: s * 1000 });

describe('trackErrors', () => {
  it('finds no error for a vehicle holding its speed', () => {
    const fixes = [fix(0, 0), fix(200, 20), fix(400, 40), fix(600, 60)];

    const { errors } = trackErrors(shape, fixes, [15, 30]);

    expect(errors.map((e) => e.horizonS)).toEqual([15, 30, 15]);
    for (const e of errors) {
      expect(e.errorM).toBeCloseTo(0, 3);
      expect(e.errorS).toBeCloseTo(0, 3);
    }
  });

  it('gives a positive error in metres and seconds when the vehicle outruns the prediction', () => {
    // 5 m/s, then 15 m/s. From the fix at 20 s, +15 s predicts 175 m; the track interpolates 325 m at 35 s,
    // and reached 175 m at 25 s.
    const fixes = [fix(0, 0), fix(100, 20), fix(400, 40)];

    const { errors } = trackErrors(shape, fixes, [15]);

    expect(errors).toHaveLength(1);
    expect(errors[0].errorM).toBeCloseTo(150, 3);
    expect(errors[0].errorS).toBeCloseTo(10, 3);
  });

  it('gives a negative error, and no error in seconds, when the vehicle stops short of the predicted point for good', () => {
    // 10 m/s, then dwelling at 200 m: +15 s predicts 350 m, which the track never reaches.
    const fixes = [fix(0, 0), fix(200, 20), fix(200, 40), fix(200, 60)];

    const { errors } = trackErrors(shape, fixes, [15]);

    expect(errors[0].errorM).toBeCloseTo(-150, 3);
    expect(errors[0].errorS).toBeNull();
  });

  it('times a dwelling vehicle from the instant nearest the prediction at which it stands at the predicted point', () => {
    // Dwelling at 200 m until 40 s, then 10 m/s. From 20 s, +15 s predicts 200 m, where the vehicle still is;
    // from 40 s, +15 s predicts 200 m again, which the vehicle left 15 s earlier.
    const fixes = [fix(200, 0), fix(200, 20), fix(200, 40), fix(400, 60)];

    const { errors } = trackErrors(shape, fixes, [15]);

    expect(errors.map((e) => [Math.round(e.errorM), e.errorS])).toEqual([[0, 0], [150, 15]]);
  });

  it('leaves out a horizon whose fixes either side are more than 30 s apart', () => {
    const fixes = [fix(0, 0), fix(200, 20), fix(500, 51)];

    const { errors } = trackErrors(shape, fixes, [15, 30]);

    expect(errors).toEqual([]);
  });

  it('counts a prediction made at the next report as stale when that report is more than 30 s later', () => {
    const fixes = [fix(0, 0), fix(200, 20), fix(400, 50), fix(600, 81), fix(800, 100)];

    const { pairs, stale } = trackErrors(shape, fixes, []);

    expect([pairs, stale]).toEqual([3, 1]);
  });
});

const { FeedMessage } = bindings.transit_realtime;
const DAY = '20261005';
const T = 1_790_000_000;
const index = await loadServiceDay(fileURLToPath(new URL('../fixtures/gtfs.zip', import.meta.url)), DAY);

describe('predictionErrors', () => {
  const a = index.stops.get('A')!;
  const b = index.stops.get('B')!;
  // f of the way from stop A to stop B, along T-weekday's shape.
  const between = (f: number) => ({ latitude: a.lat + f * (b.lat - a.lat), longitude: a.lon + f * (b.lon - a.lon) });
  const vehicle = (tripId: string, f: number, seconds: number) => ({
    id: 'V1',
    vehicle: { trip: { tripId, startDate: DAY }, vehicle: { id: 'V1' }, position: between(f), timestamp: seconds },
  });

  it('reads each trip and vehicle as one track, each fix once, and skips a trip not running that day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'error-'));
    await mkdir(join(root, 'd'));
    // Constant speed from A towards B, each fix seen in two snapshots.
    for (const [i, s] of [0, 20, 40, 60].entries()) {
      for (const lag of [5, 15]) {
        const bytes = FeedMessage.encode(FeedMessage.fromObject({
          header: { gtfsRealtimeVersion: '2.0', timestamp: T + s + lag },
          entity: [vehicle('T-weekday', i / 10, T + s), { ...vehicle('T-weekend', i / 10, T + s), id: 'V2' }],
        })).finish();
        await writeFile(join(root, 'd', `${(T + s + lag) * 1000}.pb.gz`), gzipSync(bytes));
      }
    }

    const tracks = await predictionErrors(index, root, (T - 60) * 1000, (T + 120) * 1000);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ tripId: 'T-weekday', vehicleId: 'V1', route: { shortName: 'NX1', type: 3 }, pairs: 2, stale: 0 });
    expect(tracks[0].errors.map((e) => e.horizonS)).toEqual([15, 30, 15]);
    for (const e of tracks[0].errors) expect(Math.abs(e.errorM)).toBeLessThan(1);
  });
});

describe('report', () => {
  const track = (errorsM: number[], errorS: number | null, stale: number): Track => ({
    tripId: 'T', vehicleId: 'V', route: { id: 'R', shortName: 'R', type: 3 }, pairs: 10, stale,
    errors: errorsM.map((errorM) => ({ horizonS: 15, errorM, errorS })),
  });

  it('tabulates absolute errors by nearest rank, counts errors in seconds that are undefined, and gives the stale share', () => {
    const text = report([track([-1, 2, 3, -4, 5, 6, 7, 8, 9, -10], 1, 1), track([], null, 2)]);

    expect(text).toContain('| 15 s | 10 | 5.0 / 9.0 / 10.0 | 1.0 / 1.0 / 1.0 | 0 |');
    expect(text).toContain('Stale at the next report: 3 / 20 = 15.0%');
  });
});
