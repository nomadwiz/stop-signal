import { describe, expect, it } from 'vitest';
import { hailCoordinator, type ServiceDay } from './coordinator.ts';
import type { HailEvent } from './events.ts';
import { eventLoop, scheduler } from './loop.ts';
import type { VehicleReport } from './resolve.ts';
import type { Signal } from './signal.ts';
import { recorder, type DecisionRecord } from './trace.ts';

const T = 1_790_000_000_000;
const DAY = '20261003';
// m1.test.ts's straight road east along one latitude. Stop S lies 1,335 m along it, and its previous stop P 356 m
// before S, so a stopped vehicle is due within 356 + 50 = 406 m (ADR-037's [DECIDED:05-10-2026] on a stopped vehicle).
const LAT = -36.85;
const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);
const KX = M_PER_DEGREE * Math.cos((LAT * Math.PI) / 180);
const S = { lat: LAT, lon: 174.775 };
const before = (m: number) => ({ lat: LAT, lon: S.lon - m / KX });
const stopTimes = [{ stopId: 'O' }, { stopId: 'P' }, { stopId: 'S' }, { stopId: 'Z' }];
// A1 and A2 run route R; B1 runs route Q along the same road; F1, route F, starts at S.
const road: ServiceDay = {
  day: DAY,
  previousDay: '20261002',
  stops: new Map([['S', S], ['P', { lat: LAT, lon: 174.771 }]]),
  trips: new Map([
    ['A1', { routeId: 'R', shapeId: 'road', stopTimes }],
    ['A2', { routeId: 'R', shapeId: 'road', stopTimes }],
    ['B1', { routeId: 'Q', shapeId: 'road', stopTimes }],
    ['F1', { routeId: 'F', shapeId: 'road', stopTimes: [{ stopId: 'S' }, { stopId: 'Z' }] }],
  ]),
  lateTrips: new Map(),
  tripsAtStop: new Map([['S', ['A1', 'A2', 'B1', 'F1']]]),
  shapes: new Map([['road', [{ lat: LAT, lon: 174.76 }, { lat: LAT, lon: 174.78 }]]]),
};
// A report from vehicle v on trip, m metres before S, fixed at the instant at.
const report = (v: string, tripId: string, m: number, at: number): VehicleReport => ({ vehicleId: v, tripId, startDate: DAY, ...before(m), at });

const HANDLE = '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34';
const register: HailEvent = { kind: 'register', handle: HANDLE, stopId: 'S', routeId: 'R', leadTimeS: 0 };
const cancel: HailEvent = { kind: 'cancel', handle: HANDLE, stopId: 'S', routeId: 'R' };
const start: HailEvent = { kind: 'presence-start', handle: HANDLE, stopId: 'S' };
const end: HailEvent = { kind: 'presence-end', handle: HANDLE, stopId: 'S' };
const lost: HailEvent = { kind: 'connection-lost', handle: HANDLE };

// The coordinator on a fake clock, with the real scheduler and loop, recording into an array.
function service(timetable: ServiceDay = road) {
  let now = T;
  const clock = { now: () => now };
  const records: DecisionRecord[] = [];
  const signals: Signal[] = [];
  const retracted: string[] = [];
  const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
  const apply = hailCoordinator({
    clock,
    record: recorder(clock, { append: (r) => records.push(r) }),
    signals: { signal: (s) => signals.push(s), retract: (id) => retracted.push(id) },
    schedule: wakeups.at,
    timetable,
    decelMps2: 0.9,
    dwellMs: 30_000,
  });
  // Sets the clock to t and fires every wakeup due by then, then submits each event in order, as the live adapters do.
  const at = (t: number, ...events: HailEvent[]) => {
    now = t;
    wakeups.wake();
    for (const e of events) wakeups.submit(e);
  };
  return {
    records,
    signals,
    retracted,
    kinds: () => records.map((r) => r.kind),
    at,
    tick: (t: number, ...reports: VehicleReport[]) => at(t, { kind: 'tick', reports }),
  };
}

describe('hailCoordinator: register and cancel', () => {
  it('withdraws a registered hail only on cancel, never on presence ending or the connection dropping', () => {
    const s = service();

    s.at(T, register, end, lost, { ...cancel, routeId: 'Q' }, { ...cancel, stopId: 'P' });
    expect(s.kinds()).toEqual(['registered']);

    s.at(T + 1_000, cancel);
    expect(s.records).toEqual([
      { seq: 1, at: T, kind: 'registered', hailId: 'h1', vehicleId: null, payload: { stopId: 'S', routeId: 'R', leadTimeS: 0 } },
      { seq: 2, at: T + 1_000, kind: 'withdrawn', hailId: 'h1', vehicleId: null, payload: {} },
    ]);
  });

  it('ignores a second register for a live hail, and numbers the next hail on', () => {
    const s = service();

    s.at(T, register, register, cancel, register);

    expect(s.records.map((r) => [r.kind, r.hailId])).toEqual([['registered', 'h1'], ['withdrawn', 'h1'], ['registered', 'h2']]);
  });

  it('never writes the handle, a credential (ADR-032 decision 5), to a record', () => {
    const s = service();

    s.at(T, register, start, end, cancel);

    expect(JSON.stringify(s.records)).not.toContain(HANDLE);
  });

  it('records a register for an unknown stop and route, and never throws on it', () => {
    const s = service();
    const unknown: HailEvent = { kind: 'register', handle: HANDLE, stopId: 'nowhere', routeId: 'none', leadTimeS: 60 };

    expect(() => s.at(T, unknown)).not.toThrow();
    expect(s.records[0].payload).toEqual({ stopId: 'nowhere', routeId: 'none', leadTimeS: 60 });
  });
});
