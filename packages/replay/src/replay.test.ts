import { describe, expect, it } from 'vitest';
import type { ServiceDay } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { failing, inputs, replay } from './replay.ts';

const T = 1_790_000_000_000;
const DAY = '20261003';
// coordinator.test.ts's straight road east along one latitude, stop S 1,335 m along it.
const LAT = -36.85;
const KX = 6_371_000 * (Math.PI / 180) * Math.cos((LAT * Math.PI) / 180);
const S = { lat: LAT, lon: 174.775 };
const stopTimes = [{ stopId: 'P' }, { stopId: 'S' }];
const road: ServiceDay = {
  day: DAY,
  previousDay: '20261002',
  stops: new Map([['S', S], ['P', { lat: LAT, lon: 174.771 }]]),
  trips: new Map([['A1', { routeId: 'R', shapeId: 'road', stopTimes }]]),
  lateTrips: new Map(),
  tripsAtStop: new Map([['S', ['A1']]]),
  shapes: new Map([['road', [{ lat: LAT, lon: 174.76 }, { lat: LAT, lon: 174.78 }]]]),
};
// Vehicle V1 on A1, m metres before S, fixed at the instant at.
const report = (m: number, at: number): VehicleReport => ({ vehicleId: 'V1', tripId: 'A1', startDate: DAY, lat: LAT, lon: S.lon - m / KX, at });
const HANDLE = '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34';
const register: HailEvent = { kind: 'register', handle: HANDLE, stopId: 'S', routeId: 'R', leadTimeS: 0 };
const start: HailEvent = { kind: 'presence-start', handle: HANDLE, stopId: 'S' };

describe('inputs', () => {
  it('makes each snapshot a tick at its own time and merges it with the events in time order, the tick first on a tie', () => {
    const r = report(900, T);
    expect(inputs([{ at: T, reports: [r] }, { at: T + 20_000, reports: [] }], [{ at: T + 5_000, event: start }, { at: T, event: register }])).toEqual([
      { at: T, event: { kind: 'tick', reports: [r] } },
      { at: T, event: register },
      { at: T + 5_000, event: start },
      { at: T + 20_000, event: { kind: 'tick', reports: [] } },
    ]);
  });
});

describe('replay', () => {
  it("fires each wakeup at its own time, not at the next input's, and logs each decision as a JSON line", () => {
    // Presence starts at T, so the 30 s dwell ends at T + 30 s, between the ticks at T + 20 s and T + 40 s.
    const log = replay(road, inputs([0, 20_000, 40_000].map((dt) => ({ at: T + dt, reports: [] })), [{ at: T, event: register }, { at: T, event: start }]));

    expect(log).toEqual([
      '{"seq":1,"at":1790000000000,"kind":"registered","hailId":"h1","vehicleId":null,"payload":{"stopId":"S","routeId":"R","leadTimeS":0}}',
      '{"seq":2,"at":1790000000000,"kind":"present","hailId":"h1","vehicleId":null,"payload":{}}',
      '{"seq":3,"at":1790000030000,"kind":"eligible","hailId":"h1","vehicleId":null,"payload":{}}',
    ]);
  });

  it("commits at the commit wakeup's own time, one feed interval before the deadline (ADR-037 decision 1)", () => {
    // V1 runs at 10 m/s, reporting every 20 s, and is 500 m out at T + 60 s: its stopping distance is 75.6 m, so the
    // deadline is 42.4 s later and the commit wakeup 12.4 s later, at T + 72.4 s, between the ticks at T + 60 s and T + 80 s.
    const snaps = [0, 20_000, 40_000, 60_000, 80_000].map((dt) => ({ at: T + dt, reports: [report(1_100 - dt / 100, T + dt)] }));
    const log = replay(road, inputs(snaps, [{ at: T - 60_000, event: register }, { at: T - 60_000, event: start }]));

    const committed = JSON.parse(log.find((line) => line.includes('"committed"'))!);
    expect(committed).toMatchObject({ kind: 'committed', vehicleId: 'V1' });
    expect(committed.at).toBeCloseTo(T + 72_444.4, 0);
  });
});

describe('failing', () => {
  const expected = new Map([['a.jsonl', 'x\n'], ['b.jsonl', 'y\n']]);
  it('passes when every replayed log equals its expected log', () => {
    expect(failing(new Map(expected), expected)).toEqual([]);
  });
  it('fails a replayed log that differs from its expected log', () => {
    expect(failing(new Map([['a.jsonl', 'x\n'], ['b.jsonl', 'z\n']]), expected)).toEqual(['b.jsonl']);
  });
  it('fails a replayed log with no expected log', () => {
    expect(failing(new Map([...expected, ['c.jsonl', 'w\n']]), expected)).toEqual(['c.jsonl']);
  });
  it('fails a stale expected log with no scenario', () => {
    expect(failing(new Map([['a.jsonl', 'x\n']]), expected)).toEqual(['b.jsonl']);
  });
});
