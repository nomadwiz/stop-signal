import { describe, expect, it } from 'vitest';
import { m4a } from './m4a.ts';

const T = 1_790_000_000_000;
// One decision record as the replay writes it, a JSON line in ADR-017's key order.
let seq = 0;
const registered = (hailId: string, stopId: string) =>
  JSON.stringify({ seq: ++seq, at: T, kind: 'registered', hailId, vehicleId: null, payload: { stopId, routeId: 'R', leadTimeS: 0 } });
const committed = (hailId: string, vehicleId: string, signalId: string) =>
  JSON.stringify({ seq: ++seq, at: T + 60_000, kind: 'committed', hailId, vehicleId, payload: { deadline: T + 90_000, signalId } });

describe('m4a', () => {
  it('counts one signal for an approach whose five hails share it (ADR-042)', () => {
    const log = ['h1', 'h2', 'h3', 'h4', 'h5'].flatMap((h) => [registered(h, 'S'), committed(h, 'V1', 's1')]);

    expect(m4a(log)).toEqual([1]);
  });

  it('counts each (vehicle, stop) pair as its own approach (ADR-011 decision 1)', () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', 's1'),
      registered('h2', 'S'), committed('h2', 'V2', 's2'),
      registered('h3', 'Q'), committed('h3', 'V1', 's3'),
    ];

    expect(m4a(log)).toEqual([1, 1, 1]);
  });

  it('counts two signals for an approach whose hails did not collapse into one', () => {
    const log = [registered('h1', 'S'), committed('h1', 'V1', 's1'), registered('h2', 'S'), committed('h2', 'V1', 's2')];

    expect(m4a(log)).toEqual([2]);
  });

  it('counts no approach for hails never committed', () => {
    expect(m4a([registered('h1', 'S')])).toEqual([]);
  });
});
