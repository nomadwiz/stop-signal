import { describe, expect, it } from 'vitest';
import { signalDeadline, stoppingBudget } from './deadline.ts';

const kmh = (v: number) => v / 3.6;

describe('stoppingBudget', () => {
  it('is 5.8 s at 20 km/h with a = 1.47, the band minimum', () => {
    expect(stoppingBudget(kmh(20), 1.47)).toBeCloseTo(5.8, 1);
    expect(stoppingBudget(kmh(20), 1.47)).toBeCloseTo(7646 / 1323, 12);
  });

  it('is 17.4 s at 50 km/h with a = 0.9, the band maximum', () => {
    expect(stoppingBudget(kmh(50), 0.9)).toBeCloseTo(17.4, 1);
    expect(stoppingBudget(kmh(50), 0.9)).toBeCloseTo(1412 / 81, 12);
  });

  it('rejects a deceleration outside 0.9–1.47 m/s²', () => {
    expect(() => stoppingBudget(kmh(50), 0.89)).toThrow(RangeError);
  });
});

describe('signalDeadline', () => {
  // Stopping distance at 50 km/h, a = 0.9: 2 s of reaction then v²/2a of braking, 134.95 m (R2 §2: 135 m).
  const v = kmh(50);
  const stop = v * 2 + (v * v) / (2 * 0.9);

  it('falls when the vehicle reaches its stopping distance, and the margin is the time until then', () => {
    expect(stop).toBeCloseTo(134.95, 2);
    const result = signalDeadline(1_000, stop + v * 10, v, 0.9);
    expect(result!.deadline).toBeCloseTo(11_000, 6);
    expect(result!.margin).toBeCloseTo(10_000, 6);
  });

  it('still allows a signal with no margin left at the deadline itself', () => {
    expect(signalDeadline(1_000, stop, v, 0.9)).toEqual({ deadline: 1_000, margin: 0 });
  });

  it('yields no signal once the deadline has passed', () => {
    expect(signalDeadline(1_000, stop - 1, v, 0.9)).toBeNull();
  });

  it('yields no signal for a vehicle that is stationary or already stopping', () => {
    expect(signalDeadline(1_000, 500, 0, 0.9)).toBeNull();
    expect(signalDeadline(1_000, 500, -1, 0.9)).toBeNull();
  });

  it('yields no signal when the prediction hands in no number', () => {
    expect(signalDeadline(1_000, 500, Number.NaN, 0.9)).toBeNull();
    expect(signalDeadline(1_000, Number.NaN, v, 0.9)).toBeNull();
  });

  it('rejects a deceleration outside 0.9–1.47 m/s², rather than clamping it', () => {
    expect(() => signalDeadline(1_000, 500, v, 1.48)).toThrow(RangeError);
    expect(() => signalDeadline(1_000, 500, v, Number.NaN)).toThrow(RangeError);
  });
});
