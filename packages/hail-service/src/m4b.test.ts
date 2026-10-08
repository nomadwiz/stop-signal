import { describe, expect, it } from 'vitest';
import { m4b } from './m4b.ts';

const T = 1_790_000_000_000;
// One decision record as the replay writes it, a JSON line in ADR-017's key order.
let seq = 0;
const registered = (hailId: string, stopId: string) =>
  JSON.stringify({ seq: ++seq, at: T, kind: 'registered', hailId, vehicleId: null, payload: { stopId, routeId: 'R', leadTimeS: 0 } });
const committed = (hailId: string, vehicleId: string, at: number, deadline: number | null, signalId: string) =>
  JSON.stringify({ seq: ++seq, at, kind: 'committed', hailId, vehicleId, payload: { deadline, signalId } });

describe('m4b', () => {
  it('counts an approach whose hail re-commits as corrected, over all approaches (ADR-011)', () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'), committed('h1', 'V2', T + 30_000, T + 50_000, 's2'),
      registered('h2', 'S'), committed('h2', 'V3', T + 10_000, T + 60_000, 's3'),
    ];

    expect(m4b(log)).toEqual({ approaches: 3, corrected: 1, late: 0 });
  });

  it("counts a retraction at or after the first vehicle's deadline as late, and a due-at-once commit as always late", () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'), committed('h1', 'V2', T + 60_000, T + 90_000, 's2'),
      registered('h2', 'S'), committed('h2', 'V3', T + 10_000, null, 's3'), committed('h2', 'V4', T + 20_000, T + 90_000, 's4'),
    ];

    expect(m4b(log)).toEqual({ approaches: 4, corrected: 2, late: 2 });
  });
});
