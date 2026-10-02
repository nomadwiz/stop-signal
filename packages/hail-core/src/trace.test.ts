import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.ts';
import { recorder, type DecisionRecord } from './trace.ts';

describe('recorder', () => {
  it('stamps each record from the injected Clock, never the wall clock', () => {
    const times = [1_000, 1_000, 61_500];
    const clock: Clock = { now: () => times.shift()! };
    const log: DecisionRecord[] = [];
    const record = recorder(clock, { append: (r) => log.push(r) });

    record({ kind: 'register', hailId: 'h1', vehicleId: null, payload: {} });
    record({ kind: 'register', hailId: 'h2', vehicleId: null, payload: {} });
    record({ kind: 'commit', hailId: 'h1', vehicleId: 'v9', payload: { deadline: 75_000 } });

    expect(log.map((r) => r.at)).toEqual([1_000, 1_000, 61_500]);
  });

  it('numbers records 1, 2, 3 in the order they are made', () => {
    const log: DecisionRecord[] = [];
    const record = recorder({ now: () => 0 }, { append: (r) => log.push(r) });

    record({ kind: 'register', hailId: 'h1', vehicleId: null, payload: {} });
    record({ kind: 'signal', hailId: null, vehicleId: 'v9', payload: { hails: ['h1'] } });

    expect(log).toEqual([
      { seq: 1, at: 0, kind: 'register', hailId: 'h1', vehicleId: null, payload: {} },
      { seq: 2, at: 0, kind: 'signal', hailId: null, vehicleId: 'v9', payload: { hails: ['h1'] } },
    ]);
  });
});
