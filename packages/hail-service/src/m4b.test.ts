import { describe, expect, it } from 'vitest';
import { m4b, m4bByGroup } from './m4b.ts';
import type { Scenario } from './scenarios.ts';

const T = 1_790_000_000_000;
// One decision record as the replay writes it, a JSON line in ADR-017's key order.
let seq = 0;
const record = (kind: string, hailId: string, at: number, vehicleId: string | null, payload: object) =>
  JSON.stringify({ seq: ++seq, at, kind, hailId, vehicleId, payload });
const registered = (hailId: string, stopId: string) => record('registered', hailId, T, null, { stopId, routeId: 'R', leadTimeS: 0 });
const committed = (hailId: string, vehicleId: string, at: number, deadline: number | null, signalId: string) =>
  record('committed', hailId, at, vehicleId, { deadline, signalId });

describe('m4b', () => {
  it('counts an approach whose lone hail moves as corrected, over all approaches (ADR-011)', () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'), committed('h1', 'V2', T + 30_000, T + 50_000, 's2'),
      registered('h2', 'S'), committed('h2', 'V3', T + 10_000, T + 60_000, 's3'),
    ];

    expect(m4b(log)).toEqual({ approaches: 3, corrected: 1, retractions: 1, late: 0 });
  });

  it('counts no correction when the hail moves off a signal another hail still holds, the signal being re-sent not retracted (ADR-042)', () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'),
      registered('h2', 'S'), committed('h2', 'V1', T + 10_000, T + 60_000, 's1'),
      committed('h1', 'V2', T + 30_000, T + 50_000, 's2'),
    ];

    expect(m4b(log)).toEqual({ approaches: 2, corrected: 0, retractions: 0, late: 0 });
  });

  it('counts a correction when the other hail on the signal has ended, the signal then being retracted', () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'),
      registered('h2', 'S'), committed('h2', 'V1', T + 10_000, T + 60_000, 's1'),
      record('withdrawn', 'h2', T + 20_000, 'V1', {}),
      committed('h1', 'V2', T + 30_000, T + 50_000, 's2'),
    ];

    expect(m4b(log)).toEqual({ approaches: 2, corrected: 1, retractions: 1, late: 0 });
  });

  it("counts a retraction at or after the first vehicle's deadline as late, and a due-at-once commit as always late", () => {
    const log = [
      registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'), committed('h1', 'V2', T + 60_000, T + 90_000, 's2'),
      registered('h2', 'S'), committed('h2', 'V3', T + 10_000, null, 's3'), committed('h2', 'V4', T + 20_000, T + 90_000, 's4'),
    ];

    expect(m4b(log)).toEqual({ approaches: 4, corrected: 2, retractions: 2, late: 2 });
  });
});

describe('m4bByGroup', () => {
  it("sums each scenario's M4b by its file's group (ADR-034 decision 2)", () => {
    const scenario = (group: Scenario['group']): Scenario =>
      ({ stopId: 'S', day: '20261003', dS: 17.4, n: 5, class: 'queued', group, calls: [], events: [] });
    const moved = [registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1'), committed('h1', 'V2', T + 30_000, T + 50_000, 's2')];
    const quiet = [registered('h1', 'S'), committed('h1', 'V1', T + 10_000, T + 60_000, 's1')];

    const rows = m4bByGroup([scenario('queued-on-both'), scenario('queued-on-both'), scenario('disputed')], [moved, quiet, quiet]);

    expect(rows['queued-on-both']).toEqual({ scenarios: 2, approaches: 3, corrected: 1, retractions: 1, late: 0 });
    expect(rows.disputed).toEqual({ scenarios: 1, approaches: 1, corrected: 0, retractions: 0, late: 0 });
  });
});
