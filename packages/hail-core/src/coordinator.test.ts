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
  const scheduled: { at: number; event: HailEvent }[] = [];
  const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
  const apply = hailCoordinator({
    clock,
    record: recorder(clock, { append: (r) => records.push(r) }),
    signals: {
      signal: (s) => signals.push(s),
      retract: () => {
        throw new Error('no retraction before #38');
      },
    },
    schedule: (at, event) => {
      scheduled.push({ at, event });
      wakeups.at(at, event);
    },
    timetable,
    decelMps2: 0.9,
    dwellMs: 30_000,
  });
  // Sets the clock to t and submits each event in order, as the live adapters do; with no event, fires every wakeup due
  // by then, as the live timer does. submit() fires them first itself (ADR-028 decision 1).
  const at = (t: number, ...events: HailEvent[]) => {
    now = t;
    if (!events.length) wakeups.wake();
    for (const e of events) wakeups.submit(e);
  };
  return {
    records,
    signals,
    scheduled,
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

// [kind, seconds after T] for each record, so a test reads as the timeline it asserts.
const timeline = (records: DecisionRecord[]) => records.map((r) => [r.kind, (r.at - T) / 1000]);

describe('hailCoordinator: presence and dwell', () => {
  it('never makes a hail eligible on a presence shorter than the dwell', () => {
    const s = service();

    s.at(T, register, start);
    s.at(T + 29_999, end);
    s.at(T + 60_000);

    expect(timeline(s.records)).toEqual([['registered', 0], ['present', 0], ['left', 29.999]]);
  });

  it('makes a hail eligible on a presence of exactly the dwell, before a presence-end at that instant (ADR-028 decision 1)', () => {
    const s = service();

    s.at(T, register, start);
    s.at(T + 30_000, end);

    expect(timeline(s.records)).toEqual([['registered', 0], ['present', 0], ['eligible', 30], ['left', 30]]);
  });

  it('returns a hail to Registered on a presence-end with nothing delivered, and starts a fresh dwell on return (ADR-040)', () => {
    const s = service();

    s.at(T, register, start);
    s.at(T + 30_000);
    s.at(T + 35_000, end);
    s.at(T + 40_000, start);
    s.at(T + 69_999);
    s.at(T + 70_000);

    expect(timeline(s.records)).toEqual([['registered', 0], ['present', 0], ['eligible', 30], ['left', 35], ['returned', 40], ['eligible', 70]]);
  });

  it('keeps the first presence-start\'s arrival when another arrives while present, for a hail registered after both', () => {
    const s = service();

    s.at(T, start);
    s.at(T + 20_000, start);
    s.at(T + 25_000, register);
    s.at(T + 30_000);

    expect(timeline(s.records)).toEqual([['registered', 25], ['present', 25], ['eligible', 30]]);
  });

  it('makes a hail registered while its passenger is present Present at once, eligible at presentSince + dwell (ADR-040, decided 07-10-2026)', () => {
    const s = service();

    s.at(T, start);
    s.at(T + 10_000, register);
    s.at(T + 29_999);
    s.at(T + 30_000);

    expect(timeline(s.records)).toEqual([['registered', 10], ['present', 10], ['eligible', 30]]);
  });

  it('makes a hail registered after its passenger has been present past the dwell eligible at once, connection loss aside (ADR-040, decided 07-10-2026)', () => {
    const s = service();

    s.at(T, start);
    s.at(T + 5_000, lost);
    s.at(T + 40_000, register);

    expect(timeline(s.records)).toEqual([['registered', 40], ['present', 40], ['eligible', 40]]);
  });
});

// V1 runs route R's trip A1 east at 10 m/s, 800 m before S at T; V2 runs route R's trip A2 at 10 m/s, 1,100 m before S
// at T unless told otherwise, and V3 runs route Q 200 m ahead of V1. At 10 m/s the stopping distance is 10 × 2 + 10² / (2 × 0.9) = 75.6 m, so V1's deadline is
// (800 − 75.6) / 10 = 72.4 s after T, and its commit instant 30 s before that, T + 42.4 s.
const v1 = (t: number, m = 800 - (t - T) / 100) => report('V1', 'A1', m, t);
const v2 = (t: number, atT = 1_100) => report('V2', 'A2', atT - (t - T) / 100, t);
const v3 = (t: number) => report('V3', 'B1', 600 - (t - T) / 100, t);

describe('hailCoordinator: the commit', () => {
  it('commits one feed interval before the deadline on the nearest calling vehicle of its route, handing one Signal to SignalPort (ADR-036, ADR-037 decision 1)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v3(t), v2(t), v1(t));

    s.at(T + 42_444);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.at(T + 42_445);
    expect(s.records.at(-1)).toMatchObject({ at: T + 42_445, kind: 'committed', hailId: 'h1', vehicleId: 'V1', payload: { signalId: 's1' } });
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
    expect(s.signals).toEqual([{ id: 's1', vehicleId: 'V1', stopId: 'S' }]);
  });

  it('moves the commit when a report moves the deadline, and the wakeup it replaced commits nothing', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t));
    // V1 slows to 7.5 m/s: 450 m out, a stopping distance of 46.3 m, so the deadline is 53.8 s on, T + 93.8 s.
    s.tick(T + 40_000, v1(T + 40_000, 450));

    s.at(T + 42_445);
    s.at(T + 63_833);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.at(T + 63_834);
    expect(timeline(s.records).at(-1)).toEqual(['committed', 63.834]);
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 93_833.3, 0);
    expect(s.signals).toHaveLength(1);
  });

  it('commits at once a hail that becomes eligible after its commit instant and before its deadline (ADR-037, annotated 07-10-2026)', () => {
    const s = service();
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v1(t));

    s.at(T + 20_000, register, start);
    s.at(T + 50_000);

    expect(timeline(s.records)).toEqual([['registered', 20], ['present', 20], ['eligible', 50], ['committed', 50]]);
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
  });

  it("carries each fix's match along the shape to the next, so a loop's second pass stays the second pass (ADR-022 decision 5)", () => {
    // predict.test.ts's loop: a road driven twice, 20 m apart, 1,000 m east, 20 m north, 1,000 m back west, then on
    // west to S, 2,320 m along.
    const at = (north: number, east: number) => ({ lat: LAT + north / M_PER_DEGREE, lon: 174.76 + east / KX });
    const loop: ServiceDay = {
      ...road,
      stops: new Map([['S', at(20, -300)], ['P', at(20, 300)]]),
      trips: new Map([['A1', { routeId: 'R', shapeId: 'loop', stopTimes: [{ stopId: 'P' }, { stopId: 'S' }] }]]),
      tripsAtStop: new Map([['S', ['A1']]]),
      shapes: new Map([['loop', [at(0, 0), at(0, 1_000), at(20, 1_000), at(20, 0), at(20, -500)]]]),
    };
    const fix = (north: number, east: number, t: number): VehicleReport => ({ vehicleId: 'V1', tripId: 'A1', startDate: DAY, ...at(north, east), at: t });
    const s = service(loop);
    s.at(T - 90_000, register, start);

    // V1 runs west on the second pass at 10 m/s, from 1,420 m along; its next two fixes stray 15 m south, nearer the
    // first pass. Each matched on from the one before, they sit 1,620 m and 1,820 m along, the last 500 m from S, so the
    // deadline is 42.4 s on and the commit 12.4 s on. Matched over the whole shape, the middle fix would fall on the
    // first pass, 400 m along, and drag the last one back with it.
    s.tick(T - 60_000, fix(20, 600, T - 60_000));
    s.tick(T - 40_000, fix(5, 400, T - 40_000));
    s.tick(T - 20_000, fix(5, 200, T - 20_000));
    s.at(T - 7_555);

    expect(s.records.at(-1)).toMatchObject({ kind: 'committed', vehicleId: 'V1' });
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 22_444.4, 0);
  });
});

describe('hailCoordinator: input it cannot use', () => {
  it('never resolves a hail for an unknown stop, and never throws on it', () => {
    const s = service();
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));

    expect(() => {
      s.at(T, { ...register, stopId: 'nowhere' }, { ...start, stopId: 'nowhere' });
      s.at(T + 30_000);
      s.tick(T + 35_000, v1(T + 35_000));
    }).not.toThrow();
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
  });

  it('ignores a report with no trip, an unknown trip, a one-point shape, or a fix no newer than its run\'s latest, and commits on the next valid one', () => {
    const s = service({
      ...road,
      trips: new Map([...road.trips, ['A9', { routeId: 'R', shapeId: 'dot', stopTimes }]]),
      tripsAtStop: new Map([['S', ['A1', 'A9']]]),
      shapes: new Map([...road.shapes, ['dot', [S]]]),
    });
    s.at(T - 40_000, register, start);
    s.tick(T - 20_000, v1(T - 20_000));

    const { tripId: _, ...untripped } = report('V7', 'A1', 500, T);
    expect(() => s.tick(T, untripped, report('V8', 'X9', 500, T), report('V9', 'A9', 500, T), v1(T - 20_000, 700), v1(T - 30_000, 500), v1(T), v1(T, 600))).not.toThrow();
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);
    expect(timeline(s.records).at(-1)).toEqual(['committed', 42.445]);
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
  });
});

describe('hailCoordinator: the deadline and a stale prediction', () => {
  it('skips, rather than abandons on, a bus already inside its stopping distance when the hail becomes eligible (ADR-039, annotated 07-10-2026)', () => {
    const s = service();
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000, T + 60_000]) s.tick(t, v1(t));

    // At T + 75 s V1 is 50 m out at 10 m/s, inside its 75.6 m stopping distance.
    s.at(T + 45_000, register, start);
    s.at(T + 75_000);
    s.at(T + 80_000, cancel);

    expect(timeline(s.records)).toEqual([['registered', 45], ['present', 45], ['eligible', 75], ['skipped', 75], ['withdrawn', 80]]);
    expect(s.signals).toEqual([]);
  });

  it('abandons a hail whose resolved vehicle passes inside its stopping distance, rather than going to the next bus (ADR-039 decision 3)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v2(t), v1(t));
    // V1 speeds up to 25 m/s, 100 m out: its stopping distance is 397 m. V2, 700 m out, is not taken instead.
    s.tick(T + 40_000, v2(T + 40_000), v1(T + 40_000, 100));

    expect(timeline(s.records).at(-1)).toEqual(['abandoned', 40]);
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V1', payload: { reason: 'deadline' } });
    expect(s.signals).toEqual([]);
  });

  it('does not commit on a prediction stale at the commit wakeup, and commits at once on the next fresh report before the deadline (ADR-023, ADR-037 decision 1)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));

    // At T + 42.4 s V1's latest report is 42 s old.
    s.at(T + 42_445);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.tick(T + 50_000, v1(T + 50_000));
    expect(timeline(s.records).at(-1)).toEqual(['committed', 50]);
    expect(s.signals).toHaveLength(1);
  });

  it('abandons a hail still on a stale prediction at its deadline wakeup, and sends no signal (ADR-023, decided 07-10-2026)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));

    s.at(T + 42_445);
    // The deadline wakeup, at the deadline extrapolated from the stale report, T + 72.4 s.
    const { at: deadline } = s.scheduled.findLast(({ event }) => event.kind === 'wakeup' && event.purpose === 'deadline')!;
    expect(deadline).toBeCloseTo(T + 72_444.4, 0);
    s.at(deadline - 1);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.at(deadline);
    expect(s.records.at(-1)).toMatchObject({ at: deadline, kind: 'abandoned' });
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V1', payload: { reason: 'stale' } });
    expect(s.signals).toEqual([]);
  });

  it('abandons a hail that becomes eligible on a stale prediction past its extrapolated deadline (ADR-023, decided 07-10-2026)', () => {
    const s = service();
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));

    // At T + 75 s V1 is extrapolated to 50 m out, on a report 75 s old.
    s.at(T + 45_000, register, start);
    s.at(T + 75_000);

    expect(timeline(s.records).at(-1)).toEqual(['abandoned', 75]);
    expect(s.records.at(-1)!.payload).toEqual({ reason: 'stale' });
  });
});

describe("hailCoordinator: a stopped vehicle (ADR-037's [DECIDED:05-10-2026])", () => {
  it("commits at once on a stopped vehicle within its previous stop's distance plus CALL_RADIUS_M, with no deadline", () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));

    expect(timeline(s.records).at(-1)).toEqual(['committed', 0]);
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V1', payload: { deadline: null, signalId: 's1' } });
    expect(s.signals).toEqual([{ id: 's1', vehicleId: 'V1', stopId: 'S' }]);
  });

  it('waits on a stopped vehicle beyond that reach', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t, 450));

    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
  });

  it('gives a trip whose first stop is the registered stop no rule', () => {
    const s = service();
    s.at(T - 40_000, { ...register, routeId: 'F' }, start);
    for (const t of [T - 20_000, T]) s.tick(t, report('V1', 'F1', 10, t));

    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
  });

  it('waits on a stale stopped vehicle within that reach, and commits on its next fresh report', () => {
    const s = service();
    for (const t of [T - 60_000, T - 40_000]) s.tick(t, v1(t, 380));

    // At T, when the hail becomes eligible, V1's latest report is 40 s old.
    s.at(T - 30_000, register, start);
    s.at(T);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.tick(T + 10_000, v1(T + 10_000, 380));
    expect(timeline(s.records).at(-1)).toEqual(['committed', 10]);
  });
});

// In these, V2 is route R's next bus, 800 m before S at T: its commit instant is T + 42.4 s, as V1's is in the commit tests.
describe('hailCoordinator: a candidate past its deadline goes to the next bus (ADR-039)', () => {
  it('skips at registration a moving candidate inside its stopping distance, and keeps it skipped after it stops (decisions 1 and 2)', () => {
    const s = service();
    // V1 is 60 m out at 10 m/s at T, inside its 75.6 m stopping distance.
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 60 - (t - T) / 100), v2(t, 800));
    s.at(T, register, start);
    // V1 then stands 40 m out, within the stopped-vehicle reach.
    s.tick(T + 20_000, v1(T + 20_000, 40), v2(T + 20_000, 800));
    s.at(T + 30_000);
    s.tick(T + 40_000, v1(T + 40_000, 40), v2(T + 40_000, 800));
    s.at(T + 42_445);

    expect(timeline(s.records)).toEqual([['registered', 0], ['skipped', 0], ['present', 0], ['eligible', 30], ['committed', 42.445]]);
    expect(s.records[1].payload).toEqual({ candidates: ['V1'] });
    expect(s.signals).toEqual([{ id: 's1', vehicleId: 'V2', stopId: 'S' }]);
  });

  it('skips neither a stopped candidate nor a stale one (decisions 4 and 5)', () => {
    const s = service();
    // V2's latest report is 40 s old at T, extrapolated to 50 m out at 10 m/s; V1 stands 50 m out.
    s.tick(T - 60_000, report('V2', 'A2', 650, T - 60_000));
    s.tick(T - 40_000, report('V2', 'A2', 450, T - 40_000));
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 50));

    s.at(T, register);

    expect(s.kinds()).toEqual(['registered']);
  });

  it('skips again on a return after a reported departure, adding to the hail\'s skipped set (ADR-040, decided 07-10-2026)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    s.at(T - 30_000, end);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 60 - (t - T) / 100), v2(t, 800));
    s.at(T, start);
    s.tick(T + 20_000, v1(T + 20_000, 40), v2(T + 20_000, 800));
    s.at(T + 30_000);
    s.tick(T + 40_000, v1(T + 40_000, 40), v2(T + 40_000, 800));
    s.at(T + 42_445);

    expect(timeline(s.records)).toEqual([
      ['registered', -40], ['present', -40], ['left', -30], ['returned', 0], ['skipped', 0], ['eligible', 30], ['committed', 42.445],
    ]);
    expect(s.records[4].payload).toEqual({ candidates: ['V1'] });
    expect(s.signals[0].vehicleId).toBe('V2');
  });

  it('skips on eligibility a candidate outside its stopping distance at registration and inside it by then (ADR-039, annotated 07-10-2026)', () => {
    const s = service();
    // V1 is 350 m out at 10 m/s at T, and 50 m out at T + 30 s.
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 350 - (t - T) / 100), v2(t, 800));
    s.at(T, register, start);
    s.tick(T + 20_000, v1(T + 20_000, 150), v2(T + 20_000, 800));
    s.at(T + 30_000);
    s.tick(T + 40_000, v2(T + 40_000, 800));
    s.at(T + 42_445);

    expect(timeline(s.records)).toEqual([['registered', 0], ['present', 0], ['eligible', 30], ['skipped', 30], ['committed', 42.445]]);
    expect(s.signals[0].vehicleId).toBe('V2');
  });

  it('makes "Hail the next 70" eligible at once for a passenger present past the dwell, resolving past the bus too close to stop (ADR-040, decided 07-10-2026)', () => {
    const s = service();
    s.at(T - 60_000, register, start);
    s.at(T - 30_000);
    s.tick(T - 20_000, v1(T - 20_000, 260), v2(T - 20_000, 800));
    // V1 is 60 m out at 10 m/s, inside its stopping distance: h1 ends in cannot hail, and the passenger arms again.
    s.tick(T, v1(T, 60), v2(T, 800));
    s.at(T, register);
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v2(t, 800));
    s.at(T + 42_445);

    expect(s.records.map((r) => [r.kind, (r.at - T) / 1000, r.hailId])).toEqual([
      ['registered', -60, 'h1'], ['present', -60, 'h1'], ['eligible', -30, 'h1'], ['abandoned', 0, 'h1'],
      ['registered', 0, 'h2'], ['skipped', 0, 'h2'], ['present', 0, 'h2'], ['eligible', 0, 'h2'], ['committed', 42.445, 'h2'],
    ]);
    expect(s.signals).toEqual([{ id: 's1', vehicleId: 'V2', stopId: 'S' }]);
  });
});

describe('hailCoordinator: a lost connection and a spent registration (ADR-010, ADR-040)', () => {
  it('never commits a hail whose connection drops after a reported departure (ADR-040 decision 5)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    s.at(T - 35_000, end);
    s.at(T - 30_000, lost);
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);

    expect(s.kinds()).toEqual(['registered', 'present', 'left']);
    expect(s.signals).toEqual([]);
  });

  it('marks an eligible hail Unattended when its connection drops, and still commits it (ADR-010 decision 3)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));
    s.at(T + 10_000, lost, lost);
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);

    expect(timeline(s.records)).toEqual([['registered', -40], ['present', -40], ['eligible', 0], ['unattended', 10], ['committed', 42.445]]);
    expect(s.signals).toHaveLength(1);
  });

  it('treats a presence-end while Unattended and uncommitted as a departure, clearing Unattended', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    s.at(T - 35_000, lost);
    s.at(T - 30_000, end);
    s.at(T - 20_000, start);
    s.at(T - 10_000, lost);

    expect(s.kinds()).toEqual(['registered', 'present', 'unattended', 'left', 'returned', 'unattended']);
  });

  it('spends a delivered hail on a presence-end (ADR-010 decision 1), so the next register is a new hail', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));
    s.at(T + 10_000, end);
    s.at(T + 20_000, register);

    expect(s.records.map((r) => [r.kind, r.hailId])).toEqual([
      ['registered', 'h1'], ['present', 'h1'], ['eligible', 'h1'], ['committed', 'h1'], ['spent', 'h1'], ['registered', 'h2'],
    ]);
  });

  it('never spends a delivered hail from Unattended (ADR-010 decision 4)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));
    s.at(T + 5_000, lost);
    s.at(T + 10_000, end);
    s.at(T + 20_000, register);

    expect(s.kinds()).toEqual(['registered', 'present', 'eligible', 'committed', 'unattended']);
  });

  it('withdraws a delivered hail on cancel', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));
    s.at(T + 10_000, cancel);

    expect(s.kinds()).toEqual(['registered', 'present', 'eligible', 'committed', 'withdrawn']);
  });
});
