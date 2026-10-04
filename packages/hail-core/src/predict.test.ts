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
