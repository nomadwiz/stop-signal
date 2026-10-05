import { describe, expect, it } from 'vitest';
import { predict } from './predict.ts';

// Points a given number of metres north and east of a fixed origin in Auckland.
const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);
const LAT0 = -36.85;
const at = (north: number, east = 0) => ({
  lat: LAT0 + north / M_PER_DEGREE,
  lon: 174.76 + east / (M_PER_DEGREE * Math.cos((LAT0 * Math.PI) / 180)),
});

describe('predict', () => {
  it('carries a vehicle on at its last speed along a straight shape', () => {
    const shape = [at(0), at(2_000)];
    const stop = at(1_000);
    const previous = { ...at(0), at: 0 };
    const latest = { ...at(200), at: 20_000 };

    const { distanceM, speedMps } = predict(shape, stop, previous, latest, 30_000);

    expect(speedMps).toBeCloseTo(10, 6);
    expect(distanceM).toBeCloseTo(700, 6);
  });

  it('keeps a vehicle dwelling at an earlier stop where it is', () => {
    const shape = [at(0), at(2_000)];
    const stop = at(1_000);
    const previous = { ...at(300), at: 0 };
    const latest = { ...at(300), at: 20_000 };

    const { distanceM, speedMps } = predict(shape, stop, previous, latest, 35_000);

    expect(speedMps).toBe(0);
    expect(distanceM).toBeCloseTo(700, 6);
  });

  it('keeps a dwelling vehicle whose fix jitters backwards at speed 0 and where it was', () => {
    const shape = [at(0), at(2_000)];
    const stop = at(1_000);
    const previous = { ...at(305), at: 0 };
    const latest = { ...at(300), at: 20_000 };

    const { distanceM, speedMps } = predict(shape, stop, previous, latest, 35_000);

    expect(speedMps).toBe(0);
    expect(distanceM).toBeCloseTo(700, 6);
  });

  it('flags a report more than one feed interval, 30 s, old at the instant as stale', () => {
    const shape = [at(0), at(2_000)];
    const stop = at(1_000);
    const previous = { ...at(0), at: 0 };
    const latest = { ...at(200), at: 20_000 };

    expect(predict(shape, stop, previous, latest, 50_000).stale).toBe(false);
    expect(predict(shape, stop, previous, latest, 50_001).stale).toBe(true);
  });

  it('predicts the latest report\'s position, not stale, at an instant before that report', () => {
    const shape = [at(0), at(2_000)];
    const stop = at(1_000);
    const previous = { ...at(0), at: 0 };
    const latest = { ...at(200), at: 20_000 };

    const { distanceM, speedMps, stale } = predict(shape, stop, previous, latest, 18_000);

    expect(speedMps).toBeCloseTo(10, 6);
    expect(distanceM).toBeCloseTo(800, 6);
    expect(stale).toBe(false);
  });

  it('measures distance along the shape, around a corner', () => {
    // 500 m north, then 500 m east; the stop is 300 m past the corner.
    const shape = [at(0), at(500), at(500, 500)];
    const stop = at(500, 300);
    const previous = { ...at(100), at: 0 };
    const latest = { ...at(300), at: 20_000 };

    const { distanceM, speedMps } = predict(shape, stop, previous, latest, 20_000);

    expect(speedMps).toBeCloseTo(10, 6);
    expect(distanceM).toBeCloseTo(500, 6);
  });

  // A road driven twice, 20 m apart: 1,000 m east, 20 m north, 1,000 m back west on the second pass, then 500 m on.
  // The stop is 300 m past the road's start on the way out of the loop, 2,320 m along the shape (ADR-022 decision 5).
  const loop = [at(0), at(0, 1_000), at(20, 1_000), at(20), at(20, -500)];
  const loopStop = at(20, -300);

  it('keeps a vehicle on the second pass of a loop on that pass, matched on from its last match (ADR-022 decision 5)', () => {
    // 1,620 m along, then 200 m further west at 10 m/s; the latest fix strays 15 m south, nearer the first pass.
    const previous = { ...at(20, 400), at: 0 };
    const latest = { ...at(5, 200), at: 20_000 };

    const { distanceM, speedMps, alongM } = predict(loop, loopStop, previous, latest, 20_000, 1_620);

    expect(alongM).toBeCloseTo(1_820, 6);
    expect(speedMps).toBeCloseTo(10, 6);
    expect(distanceM).toBeCloseTo(500, 6);
  });

  it('keeps a vehicle on the first pass of a loop from jumping ahead to the second pass (ADR-022 decision 5)', () => {
    // 400 m along, then 600 m along at 10 m/s; the latest fix strays 15 m north, nearer the second pass.
    const previous = { ...at(0, 400), at: 0 };
    const latest = { ...at(15, 600), at: 20_000 };

    const { distanceM, speedMps, alongM } = predict(loop, loopStop, previous, latest, 20_000, 400);

    expect(alongM).toBeCloseTo(600, 6);
    expect(speedMps).toBeCloseTo(10, 6);
    expect(distanceM).toBeCloseTo(1_720, 6);
  });

  it('without previousAlongM, equals the nearest-overall method: both reports matched over the whole shape (ADR-022 decision 5, as amended)', () => {
    // The same two fixes with no carried match: the latest, 5 m from the second pass, is matched there, 1,420 m along.
    const previous = { ...at(0, 400), at: 0 };
    const latest = { ...at(15, 600), at: 20_000 };

    const { distanceM, speedMps, alongM } = predict(loop, loopStop, previous, latest, 20_000);

    expect(alongM).toBeCloseTo(1_420, 6);
    expect(speedMps).toBeCloseTo(51, 6);
    expect(distanceM).toBeCloseTo(900, 6);
  });

  it('refuses two reports that are not in time order, since no speed follows from them', () => {
    const shape = [at(0), at(2_000)];
    const report = { ...at(300), at: 20_000 };

    expect(() => predict(shape, at(1_000), report, report, 30_000)).toThrow(RangeError);
  });

  it('refuses a shape of fewer than two points, which has no line to measure along', () => {
    const previous = { ...at(0), at: 0 };
    const latest = { ...at(200), at: 20_000 };

    expect(() => predict([at(0)], at(1_000), previous, latest, 30_000)).toThrow(RangeError);
    expect(() => predict([], at(1_000), previous, latest, 30_000)).toThrow(RangeError);
  });
});
