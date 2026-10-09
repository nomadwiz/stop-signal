import { describe, expect, it } from 'vitest';
import { hailCoordinator, type ServiceDay } from './coordinator.ts';
import type { HailEvent } from './events.ts';
import type { Outcome } from './notification.ts';
import { eventLoop, scheduler } from './loop.ts';
import type { VehicleReport } from './resolve.ts';
import type { Signal, WithdrawalReason } from './signal.ts';
import { recorder, type DecisionRecord } from './trace.ts';

const T = 1_790_000_000_000;
const DAY = '20261003';
// A straight road east along one latitude. Stop S lies 1,335 m along it, and its previous stop P 356 m
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
  // What SignalPort was handed, in order: 'signal <id>' or 'retract <id> <reason>'.
  const port: string[] = [];
  const scheduled: { at: number; event: HailEvent }[] = [];
  // What NotificationPort was handed, in order (#61).
  const outcomes: (Outcome & { handle: string })[] = [];
  const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
  const apply = hailCoordinator({
    clock,
    record: recorder(clock, { append: (r) => records.push(r) }),
    signals: {
      signal: (s) => {
        signals.push(s);
        port.push(`signal ${s.id}`);
      },
      retract: (id: string, reason: WithdrawalReason) => port.push(`retract ${id} ${reason}`),
    },
    notify: { outcome: (handle, o) => outcomes.push({ handle, ...o }) },
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
    port,
    outcomes,
    retractions: () => port.filter((p) => p.startsWith('retract')),
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
    expect(s.port).toEqual([]);
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
    expect(s.signals).toMatchObject([{ id: 's1', vehicleId: 'V1', stopId: 'S', waiting: 1 }]);
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

// S4: hails committed on one vehicle run at one stop collapse to one signal at the earliest of their deadlines (#35, FR8;
// product.md §4 step 6). Each passenger has been at S since T − 60 s, so a hail registered then is eligible at once, and
// commits at once when the tick before it puts V1 within one feed interval of its deadline.
const passenger = (n: number) => `passenger-${n}`;
const arrived = (...ns: number[]): HailEvent[] => ns.map((n) => ({ ...start, handle: passenger(n) }));
const hails = (...ns: number[]): HailEvent[] => ns.map((n) => ({ ...register, handle: passenger(n) }));
const moves = (s: Service, t: number, m: number, ...events: HailEvent[]) => s.at(t, { kind: 'tick', reports: [report('V1', 'A1', m, t)] }, ...events);
const committed = (s: Service) => s.records.filter((r) => r.kind === 'committed');

describe('hailCoordinator: aggregation (#35)', () => {
  it('collapses five hails with different deadlines to one signal at the earliest, counting all five waiting', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2, 3, 4, 5));
    moves(s, T - 10_000, 400);
    // Each tick changes V1's speed, so each hail commits on its own deadline: 10 m/s 300 m out, T + 22.4 s; 8 m/s
    // 260 m out, T + 31.1 s; 12 m/s 200 m out, T + 18.0 s; 10 m/s 150 m out, T + 22.4 s; 7.5 m/s 135 m out, T + 28.8 s.
    moves(s, T, 300, ...hails(1));
    moves(s, T + 5_000, 260, ...hails(2));
    moves(s, T + 10_000, 200, ...hails(3));
    moves(s, T + 15_000, 150, ...hails(4));
    moves(s, T + 17_000, 135, ...hails(5));

    const deadlines = committed(s).map((r) => r.payload.deadline as number);
    expect(deadlines.map((d) => Math.round((d - T) / 100) / 10)).toEqual([22.4, 31.1, 18, 22.4, 28.8]);
    expect(committed(s).map((r) => r.payload.signalId)).toEqual(['s1', 's1', 's1', 's1', 's1']);
    expect(s.signals.at(-1)).toEqual({
      id: 's1', vehicleId: 'V1', tripId: 'A1', routeId: 'R', stopId: 'S', at: T, distanceM: expect.closeTo(135, 0), deadline: Math.min(...deadlines), waiting: 5,
    });
  });

  it('moves the signal earlier when a later hail commits on a tighter deadline, and never later on a looser one', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2, 3));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1));
    expect(s.signals).toEqual([{
      id: 's1', vehicleId: 'V1', tripId: 'A1', routeId: 'R', stopId: 'S', at: T, distanceM: expect.closeTo(300, 0), deadline: expect.closeTo(T + 22_444, -1), waiting: 1,
    }]);

    // V1 speeds up to 12 m/s, 180 m out: its deadline comes forward to T + 16.3 s.
    moves(s, T + 10_000, 180, ...hails(2));
    // The signal keeps the instant it was first sent, and takes the distance at the latest join.
    expect(s.signals.at(-1)).toEqual({
      id: 's1', vehicleId: 'V1', tripId: 'A1', routeId: 'R', stopId: 'S', at: T, distanceM: expect.closeTo(180, 0), deadline: expect.closeTo(T + 16_333, -1), waiting: 2,
    });

    // V1 slows to 8 m/s, 140 m out: its deadline goes back to T + 26.1 s, and the signal keeps T + 16.3 s.
    moves(s, T + 15_000, 140, ...hails(3));
    expect(s.signals.at(-1)).toMatchObject({ id: 's1', deadline: expect.closeTo(T + 16_333, -1), waiting: 3 });
  });

  it('takes a stopped-vehicle commit, due at once with no deadline, as the earliest, and keeps it when a moving one joins', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2, 3));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1));
    moves(s, T + 10_000, 300, ...hails(2));
    // V1 moves off at 10 m/s, 200 m out: a deadline of T + 32.4 s.
    moves(s, T + 20_000, 200, ...hails(3));

    expect(committed(s).map((r) => r.payload.deadline === null)).toEqual([false, true, false]);
    expect(committed(s)[2].payload.deadline).toBeCloseTo(T + 32_444, -1);
    expect(s.signals.at(-1)).toMatchObject({ id: 's1', deadline: null, waiting: 3 });
  });

  it('gives a hail at another stop on the same vehicle run its own signal', () => {
    const s = service({ ...road, tripsAtStop: new Map([['S', ['A1']], ['P', ['A1']]]) });
    s.at(T - 60_000, ...arrived(1), { ...start, handle: passenger(2), stopId: 'P' });
    moves(s, T - 10_000, 1_400);
    moves(s, T, 1_300, ...hails(1), { ...register, handle: passenger(2), stopId: 'P' });
    for (const t of [T + 20_000, T + 40_000, T + 60_000, T + 80_000, T + 100_000]) moves(s, t, 1_300 - (t - T) / 100);
    s.at(T + 104_000);

    expect(committed(s).map((r) => [r.hailId, r.payload.signalId])).toEqual([['h2', 's1'], ['h1', 's2']]);
    expect(s.signals.map((x) => [x.id, x.stopId, x.waiting])).toEqual([['s1', 'P', 1], ['s2', 'S', 1]]);
  });

  it('gives a hail on the same vehicle\'s next run at the same stop its own signal (ADR-025)', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1));
    s.tick(T + 100_000, report('V1', 'A2', 400, T + 100_000));
    s.at(T + 110_000, { kind: 'tick', reports: [report('V1', 'A2', 300, T + 110_000)] }, ...hails(2));

    expect(s.signals.map((x) => [x.id, x.vehicleId, x.waiting])).toEqual([['s1', 'V1', 1], ['s2', 'V1', 1]]);
  });
});

describe('hailCoordinator: one run per vehicle (ADR-022, annotated 08-10-2026)', () => {
  it("drops a vehicle's finished trip when it reports on another, so the hail commits on the next bus at that bus's own commit instant", () => {
    const s = service();
    s.at(T - 60_000, register, start);
    // V1 runs A1, 10 m nearer S than V2 at 10 m/s, then reports on B1, route Q. Kept, A1's run would stay route R's
    // nearest calling vehicle, extrapolated from a report gone stale, and the hail would wait on it.
    for (const t of [T - 40_000, T - 20_000]) s.tick(t, v1(t, 990 - (t - T + 20_000) / 100), v2(t, 800));
    s.tick(T, report('V1', 'B1', 500, T), v2(T, 800));
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, report('V1', 'B1', 500 - (t - T) / 100, t), v2(t, 800));
    s.at(T + 42_445);

    expect(timeline(s.records).at(-1)).toEqual(['committed', 42.445]);
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V2' });
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
  });
});

describe('hailCoordinator: a vehicle missing from the snapshot or silent (ADR-022, annotated and decided 08-10-2026)', () => {
  it('drops a vehicle missing from the latest snapshot, so the hail commits on the next bus at its own commit instant', () => {
    const s = service();
    // V1 stands 300 m out, last reporting at T − 40 s; each snapshot re-serves that fix until V1 drops out of the feed.
    // It is stale from T − 10 s, so it holds the hail without committing it, and under 90 s old throughout.
    const parked = (t: number) => v1(t, 300);
    for (const t of [T - 60_000, T - 40_000]) s.tick(t, parked(t));
    s.at(T - 30_000, register, start);
    // V2 runs route R at 10 m/s, 800 m out at T: its commit instant is T + 42.4 s.
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, parked(T - 40_000), v2(t, 800));
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.tick(T + 40_000, v2(T + 40_000, 800));
    s.at(T + 42_444);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
    s.at(T + 42_445);
    expect(s.records.at(-1)).toMatchObject({ kind: 'committed', vehicleId: 'V2' });
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
  });

  it('passes over a vehicle whose re-served fix is more than three feed intervals old, though still in the snapshot (ADR-022, decided 08-10-2026)', () => {
    const s = service();
    // V1 stands 300 m out, last reporting at T − 80 s, and every snapshot re-serves that fix: stale, it holds the hail
    // until the fix is 90 s old, at T + 10 s, and no longer once it is older.
    const parked = (t: number) => v1(t, 300);
    for (const t of [T - 100_000, T - 80_000]) s.tick(t, parked(t));
    s.at(T - 60_000, register, start);
    for (const t of [T - 60_000, T - 40_000]) s.tick(t, parked(T - 80_000));
    // V2 runs route R at 10 m/s, 800 m out at T: its commit instant is T + 42.4 s.
    for (const t of [T - 20_000, T, T + 10_000]) s.tick(t, parked(T - 80_000), v2(t, 800));
    // At T + 10 s, its fix exactly 90 s old, V1 still holds the hail: no commit is scheduled on V2.
    expect(s.scheduled.filter(({ event }) => event.kind === 'wakeup' && event.purpose === 'commit')).toEqual([]);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    s.tick(T + 20_000, parked(T - 80_000), v2(T + 20_000, 800));
    s.at(T + 42_444);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
    s.at(T + 42_445);
    expect(s.records.at(-1)).toMatchObject({ kind: 'committed', vehicleId: 'V2' });
    expect(s.records.at(-1)!.payload.deadline).toBeCloseTo(T + 72_444.4, 0);
  });
});

describe('hailCoordinator: input it cannot use', () => {
  it('never resolves a hail for an unknown stop, and never throws on it', () => {
    const s = service();
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));

    expect(() => {
      s.at(T, { ...register, stopId: 'nowhere' }, { ...start, stopId: 'nowhere' });
      s.tick(T + 20_000, v1(T + 20_000));
      s.at(T + 30_000);
      s.tick(T + 35_000, v1(T + 35_000));
    }).not.toThrow();
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
  });

  it('ignores a report with no trip, an unknown trip, a one-point shape, or a fix no newer than its vehicle\'s latest, and commits on the next valid one', () => {
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
    // The feed stays live, re-serving V1's fix from T.
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v1(T));

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
    // The feed stays live, re-serving V1's fix from T.
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v1(T));

    s.at(T + 42_445);
    s.tick(T + 60_000, v1(T));
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

  it("abandons at a deadline wakeup only on the run the hail last resolved to, and waits for a new stale pick's own deadline (ADR-023, decided 07-10-2026; ADR-039, annotated 08-10-2026)", () => {
    const s = service();
    // V1 reports last at T + 1 s, 981.6 m out at 10 m/s: stale from T + 31 s, its extrapolated deadline is T + 91.6 s,
    // and the 90 s cutoff passes it over from T + 91 s. V2 reports last at T + 60 s, 875.6 m out at 10 m/s: stale at
    // T + 91.6 s, with its own deadline at T + 140 s, inside its 90 s.
    const a = (t: number) => v1(t, 981.6 - (t - T - 1_000) / 100);
    const b = (t: number) => report('V2', 'A2', 875.6 - (t - T - 60_000) / 100, t);
    s.at(T - 60_000, register, start);
    s.at(T - 30_000);
    // Each snapshot re-serves the vehicles' latest fixes, so the feed stays live.
    s.tick(T - 19_000, a(T - 19_000));
    for (const t of [T + 1_000, T + 21_000, T + 41_000]) s.tick(t, a(T + 1_000));
    s.tick(T + 50_000, a(T + 1_000), b(T + 50_000));
    for (const t of [T + 60_000, T + 80_000]) s.tick(t, a(T + 1_000), b(T + 60_000));
    const deadline = () => s.scheduled.findLast(({ event }) => event.kind === 'wakeup' && event.purpose === 'deadline')!.at;
    expect(deadline()).toBeCloseTo(T + 91_604.4, 0);

    s.at(deadline());
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
    expect(deadline()).toBeCloseTo(T + 140_004.4, 0);

    for (const t of [T + 100_000, T + 120_000]) s.tick(t, a(T + 1_000), b(T + 60_000));
    s.at(deadline());
    expect(s.records.at(-1)).toMatchObject({ at: deadline(), kind: 'abandoned', vehicleId: 'V2', payload: { reason: 'stale' } });
  });

  it("waits, rather than abandons, on a stale pick it never resolved to that is past its extrapolated deadline, and lets the vehicle's next report decide (ADR-039, annotated 08-10-2026)", () => {
    const s = service();
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));
    // The feed stays live, re-serving V1's fix from T.
    for (const t of [T + 20_000, T + 40_000, T + 60_000]) s.tick(t, v1(T));

    // At T + 75 s V1 is extrapolated to 50 m out, on a report 75 s old, inside its stopping distance.
    s.at(T + 45_000, register, start);
    s.at(T + 75_000);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    // V1 had slowed: at T + 80 s it reports 300 m out at 6.25 m/s, so its deadline is T + 122.5 s and it commits at
    // T + 92.5 s.
    s.tick(T + 80_000, v1(T + 80_000, 300));
    s.at(T + 92_527);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
    s.at(T + 92_528);
    expect(s.records.at(-1)).toMatchObject({ kind: 'committed', vehicleId: 'V1' });
  });

  it('waits on a new stale pick already inside its stopping distance when the cutoff passes the old one over at its deadline wakeup, until the next bus can be resolved (ADR-039, annotated 08-10-2026)', () => {
    const s = service();
    // A, V1, reports last at T + 1 s, 981.6 m out at 10 m/s: the hail follows it, waits on its stale deadline at
    // T + 91.6 s, and the 90 s cutoff passes it over from T + 91 s. B, V2, runs 15 m/s behind and reports last at
    // T + 40 s, 874 m out: at T + 91.6 s it is extrapolated to 100 m out, inside its 155 m stopping distance, and
    // past the stop from T + 98.3 s. The hail never resolved to B.
    const a = (t: number) => v1(t, 981.6 - (t - T - 1_000) / 100);
    const b = (t: number) => report('V2', 'A2', 874 - (15 * (t - T - 40_000)) / 1_000, t);
    s.at(T - 60_000, register, start);
    s.at(T - 30_000);
    s.tick(T - 19_000, a(T - 19_000));
    s.tick(T + 1_000, a(T + 1_000));
    s.tick(T + 30_000, a(T + 1_000), b(T + 30_000));
    // Each snapshot re-serves the vehicles' latest fixes, so the feed stays live.
    for (const t of [T + 40_000, T + 60_000, T + 80_000]) s.tick(t, a(T + 1_000), b(T + 40_000));
    const deadline = s.scheduled.findLast(({ event }) => event.kind === 'wakeup' && event.purpose === 'deadline')!.at;
    expect(deadline).toBeCloseTo(T + 91_604.4, 0);

    s.at(deadline);
    // A snapshot re-serving B's old fix, still inside its stopping distance, is no next report: the hail waits on.
    s.tick(T + 95_000, a(T + 1_000), b(T + 40_000));
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);

    // C, V4 on route R, 800 m out at T + 100 s at 10 m/s: once B is past the stop, the hail resolves to C, whose
    // deadline is T + 172.4 s and commit instant T + 142.4 s.
    const c = (t: number) => report('V4', 'A1', 800 - (t - T - 100_000) / 100, t);
    for (const t of [T + 100_000, T + 110_000, T + 130_000]) s.tick(t, a(T + 1_000), b(T + 40_000), c(t));
    s.at(T + 142_444);
    expect(s.kinds()).toEqual(['registered', 'present', 'eligible']);
    s.at(T + 142_445);
    expect(s.records.at(-1)).toMatchObject({ kind: 'committed', vehicleId: 'V4' });
  });
});

describe("hailCoordinator: a stopped vehicle (ADR-037's [DECIDED:05-10-2026])", () => {
  it("commits at once on a stopped vehicle within its previous stop's distance plus CALL_RADIUS_M, with no deadline", () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));

    expect(timeline(s.records).at(-1)).toEqual(['committed', 0]);
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V1', payload: { deadline: null, signalId: 's1' } });
    expect(s.signals).toMatchObject([{ id: 's1', vehicleId: 'V1', stopId: 'S', waiting: 1 }]);
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
    s.tick(T - 20_000, v1(T - 40_000, 380));

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
    expect(s.signals).toMatchObject([{ id: 's1', vehicleId: 'V2', stopId: 'S', waiting: 1 }]);
  });

  it('skips neither a stopped candidate nor a stale one (decisions 4 and 5)', () => {
    const s = service();
    // V2's latest report is 40 s old at T, extrapolated to 50 m out at 10 m/s, and each snapshot re-serves it; V1
    // stands 50 m out.
    s.tick(T - 60_000, report('V2', 'A2', 650, T - 60_000));
    const v2Stale = report('V2', 'A2', 450, T - 40_000);
    s.tick(T - 40_000, v2Stale);
    for (const t of [T - 20_000, T]) s.tick(t, v2Stale, v1(t, 50));

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

  it('skips a bus first seen already inside its stopping distance, and resolves to the next bus (ADR-039, annotated 08-10-2026)', () => {
    const s = service();
    s.at(T - 60_000, register, start);
    s.at(T - 30_000);
    s.tick(T - 20_000, v1(T - 20_000, 260), v2(T - 20_000, 800));
    // V1 is first predictable at T, 60 m out at 10 m/s, inside its stopping distance; the hail never resolved to it.
    s.tick(T, v1(T, 60), v2(T, 800));
    for (const t of [T + 20_000, T + 40_000]) s.tick(t, v2(t, 800));
    s.at(T + 42_445);

    expect(timeline(s.records)).toEqual([['registered', -60], ['present', -60], ['eligible', -30], ['skipped', 0], ['committed', 42.445]]);
    expect(s.records[3].payload).toEqual({ candidates: ['V1'] });
    expect(s.signals).toMatchObject([{ id: 's1', vehicleId: 'V2', stopId: 'S', waiting: 1 }]);
  });

  it('counts a stale pick as resolved to, so its next fresh report inside its stopping distance abandons the hail (ADR-039, annotated 08-10-2026)', () => {
    const s = service();
    // At T, when the hail becomes eligible, V1's latest report is 40 s old and extrapolated to 400 m out: the hail
    // resolves to it, stale. At T + 5 s V1 reports 100 m out at 15.6 m/s, inside its 165 m stopping distance.
    for (const t of [T - 60_000, T - 40_000]) s.tick(t, v1(t, 400 - (t - T) / 100));
    s.at(T - 30_000, register, start);
    s.tick(T - 20_000, v1(T - 40_000, 800));
    s.at(T);
    s.tick(T + 5_000, v1(T + 5_000, 100));

    expect(timeline(s.records)).toEqual([['registered', -30], ['present', -30], ['eligible', 0], ['abandoned', 5]]);
    expect(s.records.at(-1)).toMatchObject({ vehicleId: 'V1', payload: { reason: 'deadline' } });
  });

  it('makes "Hail the next 70" eligible at once for a passenger present past the dwell, resolving past the bus too close to stop (ADR-040, decided 07-10-2026)', () => {
    const s = service();
    s.at(T - 60_000, register, start);
    s.at(T - 30_000);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t), v2(t));
    // V1, which h1 resolved to, speeds up to 25 m/s, 100 m out: h1 ends in cannot hail, and the passenger arms again.
    s.tick(T + 40_000, v1(T + 40_000, 100), v2(T + 40_000));
    s.at(T + 40_000, register);
    // V2 is 700 m out at T + 40 s, so its deadline is T + 102.4 s and its commit instant T + 72.4 s.
    s.tick(T + 60_000, v2(T + 60_000));
    s.at(T + 72_445);

    expect(s.records.map((r) => [r.kind, (r.at - T) / 1000, r.hailId])).toEqual([
      ['registered', -60, 'h1'], ['present', -60, 'h1'], ['eligible', -30, 'h1'], ['abandoned', 40, 'h1'],
      ['registered', 40, 'h2'], ['skipped', 40, 'h2'], ['present', 40, 'h2'], ['eligible', 40, 'h2'], ['committed', 72.445, 'h2'],
    ]);
    expect(s.signals).toMatchObject([{ id: 's1', vehicleId: 'V2', stopId: 'S', waiting: 1 }]);
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
    expect(s.port).toEqual(['signal s1', 'retract s1 left']);
  });

  it('spends a delivered hail on an explicit presence-end even when Unattended: decision 4 covers silence only (ADR-010, annotated 08-10-2026)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));
    s.at(T + 5_000, lost);
    s.at(T + 10_000, end);
    s.at(T + 20_000, register);

    expect(s.records.map((r) => [r.kind, r.hailId])).toEqual([
      ['registered', 'h1'], ['present', 'h1'], ['eligible', 'h1'], ['committed', 'h1'], ['unattended', 'h1'], ['spent', 'h1'], ['registered', 'h2'],
    ]);
  });

  it('withdraws a delivered hail on cancel, retracting its signal (FR2, FR12)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T]) s.tick(t, v1(t, 380));
    s.at(T + 10_000, cancel);

    expect(s.kinds()).toEqual(['registered', 'present', 'eligible', 'committed', 'withdrawn']);
    expect(s.port).toEqual(['signal s1', 'retract s1 cancelled']);
  });
});

// C5 (#41; FR14, QR7): the feed is stale once the Clock is more than one feed interval past the last tick, and the next
// tick ends it (ADR-022 decision 3; ADR-017 and ADR-038, annotated 09-10-2026).
describe('hailCoordinator: a stale feed (#41)', () => {
  const other = (handle: string, e: HailEvent) => ({ ...e, handle }) as HailEvent;

  it('abandons every live hail in one wakeup once no tick has come for more than one feed interval, and retracts the signal', () => {
    const s = service();
    // h1 commits on V1 at T + 42.4 s; h2 is Registered for route Q, its passenger away; h3's passenger arrives at T + 50 s.
    s.at(T - 60_000, register, start, other('B', { ...register, routeId: 'Q' }));
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);
    s.at(T + 50_000, other('C', register), other('C', start));

    s.at(T + 70_000);
    expect(s.kinds()).toEqual(['registered', 'present', 'registered', 'eligible', 'committed', 'registered', 'present']);

    s.at(T + 70_001);
    expect(s.records.slice(-3).map(({ at, kind, hailId, vehicleId, payload }) => [at - T, kind, hailId, vehicleId, payload])).toEqual([
      [70_001, 'abandoned', 'h1', 'V1', { reason: 'feed' }],
      [70_001, 'abandoned', 'h2', null, { reason: 'feed' }],
      [70_001, 'abandoned', 'h3', null, { reason: 'feed' }],
    ]);
    // The committed hail's signal is retracted with feed (ADR-038, decided 09-10-2026).
    expect(s.port).toEqual(['signal s1', 'retract s1 feed']);
  });

  it('stops prediction while the feed is stale: a hail registered then is abandoned at once, and the next tick ends it', () => {
    const s = service();
    for (const t of [T - 20_000, T]) s.tick(t, v1(t));
    s.at(T + 30_001);

    s.at(T + 35_000, register, start);
    expect(s.records).toEqual([
      { seq: 1, at: T + 35_000, kind: 'registered', hailId: 'h1', vehicleId: null, payload: { stopId: 'S', routeId: 'R', leadTimeS: 0 } },
      { seq: 2, at: T + 35_000, kind: 'abandoned', hailId: 'h1', vehicleId: null, payload: { reason: 'feed' } },
    ]);

    s.tick(T + 40_000, v1(T + 40_000));
    s.at(T + 40_000, register);
    expect(timeline(s.records).slice(2)).toEqual([['registered', 40], ['present', 40]]);
    expect(s.signals).toEqual([]);
  });

  it('counts a tick exactly one feed interval after the last as on time', () => {
    const s = service();
    s.at(T - 60_000, register);
    s.tick(T, v1(T));
    s.tick(T + 30_000, v1(T + 30_000));
    s.at(T + 60_000);

    expect(s.kinds()).toEqual(['registered']);
  });

  it('is not stale before the first tick', () => {
    const s = service();
    s.at(T, register);
    s.at(T + 600_000, other('B', register));

    expect(s.kinds()).toEqual(['registered', 'registered']);
  });
});

describe('hailCoordinator: the outcome (#61, FR11)', () => {
  // h1 commits on V1 at T + 42.4 s, its deadline T + 72.4 s; V1 reports every 20 s until T + 60 s.
  const committed = () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);
    s.tick(T + 60_000, v1(T + 60_000));
    return s;
  };
  const told = (outcome: Outcome['outcome']) => ({ handle: HANDLE, stop: 'S', route: 'R', outcome });

  it('tells the passenger confirmed when the console acknowledges the hail\'s signal, and nothing more at its deadline', () => {
    const s = committed();

    s.at(T + 50_000, { kind: 'console-ack', signalId: 's1' });
    s.at(T + 80_000);

    expect(s.outcomes).toEqual([told('confirmed')]);
    expect(s.records.filter((r) => r.kind === 'confirmed')).toMatchObject([{ at: T + 50_000, hailId: 'h1', vehicleId: 'V1', payload: {} }]);
  });

  it('tells the passenger unacknowledged at the hail\'s deadline with no acknowledgement, and ignores a later one', () => {
    const s = committed();

    s.at(T + 72_444);
    expect(s.outcomes).toEqual([]);
    s.at(T + 72_445);
    s.at(T + 75_000, { kind: 'console-ack', signalId: 's1' });

    expect(s.outcomes).toEqual([told('unacknowledged')]);
    expect(timeline(s.records).at(-1)).toEqual(['unacknowledged', 72.445]);
  });

  it('tells the passenger cannot hail, feed stale, when a stale feed abandons the hail', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000, T + 40_000]) s.tick(t, v1(t));
    s.at(T + 42_445);

    s.at(T + 70_001);

    expect(s.outcomes).toEqual([{ ...told('cannot-hail'), reason: 'feed' }]);
  });

  it('tells the passenger cannot hail, deadline unreachable, with how far away the route\'s next bus is (ADR-038)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v2(t), v1(t));
    // V1 speeds up to 25 m/s, 100 m out, inside its stopping distance; V2 is 700 m out.
    s.tick(T + 40_000, v2(T + 40_000), v1(T + 40_000, 100));

    expect(s.outcomes).toMatchObject([{ ...told('cannot-hail'), reason: 'deadline' }]);
    expect(s.outcomes[0].nextDistanceM).toBeCloseTo(700, 0);
  });

  it('tells cannot hail with reason stale when the bus\'s prediction is still stale at the deadline (#61-4)', () => {
    const s = service();
    states['eligible, stale'].reach(s);

    s.at(T + 72_445);

    expect(s.outcomes).toEqual([{ ...told('cannot-hail'), reason: 'stale' }]);
  });

  it('tells a hail committed on a stopped vehicle unacknowledged once its run stops calling at the stop (#61-1)', () => {
    const s = service();
    s.at(T - 40_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t, 380));
    expect(s.outcomes).toEqual([]);

    // V1 is 50 m past S.
    s.tick(T + 40_000, v1(T + 40_000, -50));

    expect(s.outcomes).toEqual([told('unacknowledged')]);
  });

  it('tells a hail spent before an acknowledgement or its deadline nothing (#61-2)', () => {
    const s = committed();

    s.at(T + 50_000, end);
    s.at(T + 80_000, { kind: 'console-ack', signalId: 's1' });

    expect(s.outcomes).toEqual([]);
  });

  it('tells a hail moved to another bus its new signal\'s outcome, though told the first (#61-3)', () => {
    const s = service();
    s.at(T - 60_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t));
    s.tick(T + 40_000, v1(T + 40_000), report('V2', 'A2', 600, T + 40_000));
    s.at(T + 42_445);
    s.at(T + 50_000, { kind: 'console-ack', signalId: 's1' });
    // V1 slows at 380 m; V2, 300 m out, is due: h1 moves to s2.
    s.tick(T + 60_000, v1(T + 60_000, 380), report('V2', 'A2', 300, T + 60_000));

    s.at(T + 61_000, { kind: 'console-ack', signalId: 's2' });

    expect(s.outcomes).toEqual([told('confirmed'), told('confirmed')]);
  });
});

// S5: retraction (#38, FR12). A signal is retracted when its last live hail leaves it; a changed resolution retracts
// it from the first vehicle and signals the second (ADR-003; ADR-037 decision 1).
describe('hailCoordinator: withdrawal and re-sending (#38)', () => {
  it('retracts from the first vehicle, then signals the second, when a fresh report puts a due bus of the route nearer', () => {
    const s = service();
    s.at(T - 60_000, register, start);
    for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t));
    s.tick(T + 40_000, v1(T + 40_000), report('V2', 'A2', 600, T + 40_000));
    s.at(T + 42_445);
    // V1 slows to 1 m/s at 380 m; V2 comes on at 15 m/s, 300 m out, past its commit instant (deadline T + 69.7 s).
    s.tick(T + 60_000, v1(T + 60_000, 380), report('V2', 'A2', 300, T + 60_000));

    expect(committed(s).map((r) => [r.hailId, r.vehicleId, r.payload.signalId])).toEqual([['h1', 'V1', 's1'], ['h1', 'V2', 's2']]);
    expect(s.port).toEqual(['signal s1', 'retract s1 moved', 'signal s2']);
    // The retraction goes out at the second commit, before the first vehicle's deadline (#39, FR12).
    const [first, second] = committed(s);
    expect(second.at).toBeLessThan(first.payload.deadline as number);
  });

  // V2 reports as [tick, metres before S, fix], seconds from T. V1 commits h1 at T + 42.4 s and slows to 1 m/s 380 m out
  // at T + 60 s, where V2 is nearer: only the guard named keeps h1 on V1.
  it.each([
    ['stale (ADR-037 decision 1)', [[20, 750, 10], [40, 600, 25], [60, 600, 25]]],
    ['not yet at its commit instant (ADR-037 decision 1)', [[40, 470, 40], [60, 370, 60]]],
    ['inside its stopping distance (ADR-003 Alt 3)', [[40, 700, 40], [60, 100, 60]]],
    ['skipped at registration, though stopped within reach since (ADR-039 decisions 1 and 2)',
      [[-80, 400, -80], [-70, 250, -70], [-50, 50, -50], [-40, 50, -40], [-20, 50, -20], [0, 50, 0], [20, 50, 20], [40, 50, 40], [60, 50, 60]]],
    // P 100 m before S, so the reach is 150 m.
    ["stopped beyond its previous stop's reach (ADR-037's [DECIDED:05-10-2026])", [[40, 300, 40], [60, 300, 60]], { ...road, stops: new Map([['S', S], ['P', before(100)]]) }],
  ] as [string, number[][], ServiceDay?][])('keeps the hail on its bus when the nearer one is %s', (_, v2, timetable) => {
    const s = service(timetable);
    const tick = (t: number, ...reports: VehicleReport[]) =>
      s.tick(T + t * 1_000, ...reports, ...v2.filter(([at]) => at === t).map(([, m, fix]) => report('V2', 'A2', m, T + fix * 1_000)));
    tick(-80);
    tick(-70);
    s.at(T - 60_000, register, start);
    for (const t of [-50, -40]) tick(t);
    for (const t of [-20, 0, 20, 40]) tick(t, v1(T + t * 1_000));
    s.at(T + 42_445);
    tick(60, v1(T + 60_000, 380));

    expect(s.port).toEqual(['signal s1']);
  });

  it('keeps a shared signal while any of its hails is live, and retracts it when the last one leaves', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1, 2));
    s.at(T + 5_000, { ...cancel, handle: passenger(1) });
    expect(s.retractions()).toEqual([]);

    s.at(T + 6_000, { ...end, handle: passenger(2) });
    expect(s.port).toEqual(['signal s1', 'signal s1', 'signal s1', 'retract s1 left']);
  });

  it('re-sends a shared signal under its id when one hail leaves, one fewer waiting, at the earliest deadline left (ADR-042, decided 09-10-2026)', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2));
    moves(s, T - 10_000, 400);
    // h1 commits on a deadline of T + 22.4 s, h2 on T + 31.1 s (as in aggregation's first test).
    moves(s, T, 300, ...hails(1));
    moves(s, T + 5_000, 260, ...hails(2));
    s.at(T + 6_000, { ...cancel, handle: passenger(1) });

    expect(s.signals.at(-1)).toMatchObject({ id: 's1', waiting: 1, deadline: committed(s)[1].payload.deadline });
    expect(s.retractions()).toEqual([]);
  });

  it('keeps a stopped-vehicle commit\'s null deadline, earliest of all, when a moving hail leaves the signal (ADR-042 decisions 2 and 4)', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1));
    moves(s, T + 10_000, 300, ...hails(2));
    s.at(T + 11_000, { ...cancel, handle: passenger(1) });

    expect(s.signals.at(-1)).toMatchObject({ id: 's1', waiting: 1, deadline: null });
  });

  it('retracts a shared signal once with feed when a stale feed ends its hails, with no re-send first (ADR-038)', () => {
    const s = service();
    s.at(T - 60_000, ...arrived(1, 2));
    moves(s, T - 10_000, 400);
    moves(s, T, 300, ...hails(1, 2));
    s.at(T + 30_001);

    expect(s.port).toEqual(['signal s1', 'signal s1', 'retract s1 feed']);
  });
});

// T2, the lifecycle unit suite (doc/output/m1-revised.md §7.2; #33): every state a hail can be in, against every event
// ADR-031 defines plus tick and each wakeup. Each state is reached on V1's run, 800 m before S at T at 10 m/s (deadline
// T + 72.4 s, commit instant T + 42.4 s), and reach() returns E, the instant the event under test arrives, before any
// wakeup the state still waits for. A row names the records the event writes, by kind and abandonment reason, and the
// rule that settles it.
type Service = ReturnType<typeof service>;
const states = {
  none: { trail: [], reach: (s: Service) => (s.tick(T - 20_000, v1(T - 20_000)), s.tick(T, v1(T)), T + 20_000) },
  registered: {
    trail: ['registered'],
    reach: (s: Service) => (s.at(T - 60_000, register), s.tick(T - 20_000, v1(T - 20_000)), s.tick(T, v1(T)), T + 20_000),
  },
  // Registered after a reported departure with nothing delivered (ADR-040 decision 3); its dwell wakeup is void.
  left: {
    trail: ['registered', 'present', 'left'],
    reach: (s: Service) => {
      s.at(T - 60_000, register, start);
      s.at(T - 50_000, end);
      for (const t of [T - 20_000, T]) s.tick(t, v1(t));
      return T + 20_000;
    },
  },
  // Its dwell wakeup is at T + 30 s.
  present: {
    trail: ['registered', 'present'],
    reach: (s: Service) => (s.tick(T - 20_000, v1(T - 20_000)), s.tick(T, v1(T)), s.at(T, register, start), T + 20_000),
  },
  'present, unattended': {
    trail: ['registered', 'present', 'unattended'],
    reach: (s: Service) => (states.present.reach(s), s.at(T, lost), T + 20_000),
  },
  // Waiting on its commit wakeup at T + 42.4 s, V1's last report at T + 20 s.
  eligible: {
    trail: ['registered', 'present', 'eligible'],
    reach: (s: Service) => {
      s.at(T - 60_000, register, start);
      for (const t of [T - 20_000, T, T + 20_000]) s.tick(t, v1(t));
      return T + 40_000;
    },
  },
  'eligible, unattended': {
    trail: ['registered', 'present', 'eligible', 'unattended'],
    reach: (s: Service) => (states.eligible.reach(s), s.at(T + 20_000, lost), T + 40_000),
  },
  // Waiting on its deadline wakeup at T + 72.4 s: V1's last report, at T, was stale at the commit wakeup. Each later
  // snapshot re-serves it, so the feed stays live until T + 75 s.
  'eligible, stale': {
    trail: ['registered', 'present', 'eligible'],
    reach: (s: Service) => {
      s.at(T - 60_000, register, start);
      for (const t of [T - 20_000, T]) s.tick(t, v1(t));
      for (const t of [T + 20_000, T + 40_000]) s.tick(t, v1(T));
      s.at(T + 42_445);
      s.tick(T + 45_000, v1(T));
      return T + 50_000;
    },
  },
  committed: {
    trail: ['registered', 'present', 'eligible', 'committed'],
    reach: (s: Service) => (states.eligible.reach(s), s.at(T + 42_445), T + 50_000),
  },
  'committed, unattended': {
    trail: ['registered', 'present', 'eligible', 'committed', 'unattended'],
    reach: (s: Service) => (states.committed.reach(s), s.at(T + 42_445, lost), T + 50_000),
  },
  // The three endings. Withdrawn and Abandoned leave the passenger's presence held; Spent ends it.
  withdrawn: {
    trail: ['registered', 'present', 'eligible', 'withdrawn'],
    reach: (s: Service) => (states.eligible.reach(s), s.at(T + 20_000, cancel), T + 40_000),
  },
  spent: {
    trail: ['registered', 'present', 'eligible', 'committed', 'spent'],
    reach: (s: Service) => (states.committed.reach(s), s.at(T + 45_000, end), T + 50_000),
  },
  abandoned: {
    trail: ['registered', 'present', 'eligible', 'abandoned stale'],
    reach: (s: Service) => (states['eligible, stale'].reach(s), s.at(T + 72_445), s.tick(T + 75_000, v1(T)), T + 80_000),
  },
  // No hail, and no tick since T: the watchdog ended the feed at T + 30.001 s (#41).
  'feed stale': { trail: [], reach: (s: Service) => (states.none.reach(s), s.at(T + 30_001), T + 40_000) },
};
type State = keyof typeof states;

// h1's latest wakeup of this purpose: fired at its own instant if that is still to come, else submitted again at E,
// as a stale one would arrive; a wakeup at E if it never had one.
const fire = (purpose: 'dwell' | 'commit' | 'deadline') => (s: Service, e: number) => {
  const w = s.scheduled.findLast(({ event }) => event.kind === 'wakeup' && event.purpose === purpose && 'hailId' in event && event.hailId === 'h1');
  if (w && w.at >= e) s.at(w.at);
  else s.at(e, w?.event ?? { kind: 'wakeup', at: e, hailId: 'h1', purpose });
};
const events = {
  register: (s: Service, e: number) => s.at(e, register),
  cancel: (s: Service, e: number) => s.at(e, cancel),
  'presence-start': (s: Service, e: number) => s.at(e, start),
  'presence-end': (s: Service, e: number) => s.at(e, end),
  'connection-lost': (s: Service, e: number) => s.at(e, lost),
  'console-ack': (s: Service, e: number) => s.at(e, { kind: 'console-ack', signalId: 's1' }),
  tick: (s: Service, e: number) => s.tick(e, v1(e)),
  // V1 reports 100 m out, inside its stopping distance at the speed its last two reports give.
  'tick, too close': (s: Service, e: number) => s.tick(e, v1(e, 100)),
  'wakeup dwell': fire('dwell'),
  'wakeup commit': fire('commit'),
  'wakeup deadline': fire('deadline'),
  // The watchdog the last tick set, at its own instant, after every wakeup due before it has fired with the clock 1 ms
  // short (ADR-028 decision 1); submitted again at E if it has already fired.
  'wakeup feed': (s: Service, e: number) => {
    const w = s.scheduled.findLast(({ event }) => event.kind === 'wakeup' && event.purpose === 'feed')!;
    if (w.at >= e) (s.at(w.at - 1), s.at(w.at));
    else s.at(e, w.event);
  },
};
type Row = [written: string[], rule: string, next?: [act: (s: Service, e: number) => void, written: string[]]];

const WITHDRAWS = 'FR2; ADR-017, decided 07-10-2026';
const NO_HAIL = 'no hail';
const NO_RERESOLVE = 'no nearer bus of its route, so the resolution stands: ADR-003; ADR-037 decision 1';
const RETRACTS = 'FR2, FR12: the hail was its signal\'s last';
const ALREADY_UNATTENDED = 'already Unattended: ADR-017, one record per transition';
const DUPLICATE = 'one live hail per handle, stop and route: ADR-032 decision 4; ADR-010, annotated 08-10-2026';
const ENDED = 'the hail has ended, so nothing names it';
const NOT_ELIGIBLE = 'only an eligible hail resolves: ADR-039, annotated 07-10-2026; ADR-040 decision 3';
const NOT_SIGNALLED = 'no signal of its own to acknowledge: #61';
const CONFIRMED = 'an acknowledgement of its signal is confirmed: FR11; #61';
const STALE_WAKEUP = 'not the wakeup the hail waits for: ADR-040 decisions 2 and 3; ADR-037 decision 1';
const SAME_PRESENCE = 'presence runs from the first presence-start until a presence-end: ADR-006; ADR-040, annotated 07-10-2026';
const FEED_RULE = 'ADR-017 and ADR-038, annotated 09-10-2026';
const FEED = `a stale feed abandons every live hail: ${FEED_RULE}`;
// Unattended stays, so a second lost connection writes nothing.
const STILL_UNATTENDED: Row = [[], 'no reconnection event, so Unattended holds: ADR-010, annotated 09-10-2026', [(s, e) => s.at(e, lost), []]];

const table: Record<keyof typeof events, Record<State, Row>> = {
  register: {
    none: [['registered'], 'ADR-031; ADR-039 decision 1'],
    registered: [[], DUPLICATE],
    left: [[], `${DUPLICATE}; the registration stays live, ADR-040 decision 1`],
    present: [[], DUPLICATE],
    'present, unattended': [[], DUPLICATE],
    eligible: [[], DUPLICATE],
    'eligible, unattended': [[], DUPLICATE],
    'eligible, stale': [[], DUPLICATE],
    committed: [[], DUPLICATE],
    'committed, unattended': [[], `${DUPLICATE}; Unattended never spends it, ADR-010 decision 4`],
    withdrawn: [['registered', 'present', 'eligible'], 'a new hail, Present and Eligible at once on held presence: ADR-040, annotated and decided 07-10-2026'],
    spent: [['registered'], 'a new hail; the presence-end that spent the last one ended presence: ADR-010 decision 1'],
    abandoned: [['registered', 'present', 'eligible'], '"Hail the next 70": ADR-040, decided 07-10-2026; ADR-039'],
    'feed stale': [['registered', 'abandoned feed'], `${FEED} at once`, [(s, e) => (s.tick(e + 1_000, v1(e + 1_000)), s.at(e + 1_000, register)), ['registered']]],
  },
  cancel: {
    none: [[], 'nothing to withdraw'],
    registered: [['withdrawn'], WITHDRAWS],
    left: [['withdrawn'], WITHDRAWS],
    present: [['withdrawn'], WITHDRAWS],
    'present, unattended': [['withdrawn'], WITHDRAWS],
    eligible: [['withdrawn'], WITHDRAWS, [(s) => s.at(T + 42_445), []]],
    'eligible, unattended': [['withdrawn'], WITHDRAWS],
    'eligible, stale': [['withdrawn'], WITHDRAWS],
    committed: [['withdrawn', 'retract s1 cancelled'], RETRACTS],
    'committed, unattended': [['withdrawn', 'retract s1 cancelled'], RETRACTS],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], 'nothing to withdraw'],
  },
  'presence-start': {
    none: [[], 'presence is held for a later register: ADR-040, annotated 07-10-2026', [(s, e) => s.at(e + 1_000, register), ['registered', 'present']]],
    registered: [['present'], 'FR4; ADR-041 decision 1'],
    left: [['returned'], 'a fresh dwell and the skip on return: ADR-040 decision 2, decided 07-10-2026', [(s, e) => (s.tick(e, v1(T)), s.tick(e + 20_000, v1(T)), s.at(e + 30_000)), ['eligible']]],
    present: [[], SAME_PRESENCE, [(s) => s.at(T + 30_000), ['eligible']]],
    'present, unattended': STILL_UNATTENDED,
    eligible: [[], SAME_PRESENCE],
    'eligible, unattended': STILL_UNATTENDED,
    'eligible, stale': [[], SAME_PRESENCE],
    committed: [[], SAME_PRESENCE],
    'committed, unattended': STILL_UNATTENDED,
    withdrawn: [[], `${ENDED}; ${SAME_PRESENCE}`, [(s, e) => s.at(e + 1_000, register), ['registered', 'present', 'eligible']]],
    spent: [[], 'returning fires nothing: ADR-010 decision 1', [(s, e) => (s.tick(e, v1(e)), s.at(e + 1_000, register)), ['registered', 'present']]],
    abandoned: [[], `${ENDED}; ${SAME_PRESENCE}`],
    'feed stale': [[], 'presence is held for a later register: ADR-040, annotated 07-10-2026', [(s, e) => s.at(e + 1_000, register), ['registered', 'abandoned feed']]],
  },
  'presence-end': {
    none: [[], 'no hail and no presence'],
    registered: [[], 'nothing to depart from, and only cancel withdraws: ADR-010 decision 2; ADR-017, decided 07-10-2026'],
    left: [[], 'already Registered: ADR-040 decision 3'],
    present: [['left'], 'back to Registered: ADR-040 decision 3'],
    'present, unattended': [['left'], 'back to Registered, the departure reported: ADR-040 decisions 3 and 5'],
    eligible: [['left'], 'back to Registered, uncommitted: ADR-040 decision 3', [(s) => s.at(T + 42_445), []]],
    'eligible, unattended': [['left'], 'back to Registered, the departure reported: ADR-040 decisions 3 and 5'],
    'eligible, stale': [['left'], 'back to Registered, uncommitted: ADR-040 decision 3', [(s) => s.at(T + 72_445), []]],
    committed: [['spent', 'retract s1 left'], 'FR12, FR13; ADR-010 decisions 1 and 2'],
    'committed, unattended': [['spent', 'retract s1 left'], 'FR12; ADR-010, annotated 08-10-2026'],
    withdrawn: [[], `${ENDED}; presence ends`, [(s, e) => s.at(e + 1_000, register), ['registered']]],
    spent: [[], ENDED],
    abandoned: [[], `${ENDED}; presence ends`],
    'feed stale': [[], NO_HAIL],
  },
  'connection-lost': {
    none: [[], NO_HAIL],
    registered: [[], 'Unattended applies at the stop only: ADR-010, annotated 07-10-2026'],
    left: [[], 'stays Registered, uncommitted: ADR-040 decision 5', [(s) => [T + 20_000, T + 40_000, T + 60_000, T + 80_000].forEach((t) => s.tick(t, v1(t))), []]],
    present: [['unattended'], 'ADR-010 decision 3; ADR-040 decision 5'],
    'present, unattended': [[], ALREADY_UNATTENDED],
    eligible: [['unattended'], 'ADR-010 decision 3', [(s) => s.at(T + 42_445), ['committed']]],
    'eligible, unattended': [[], ALREADY_UNATTENDED],
    'eligible, stale': [['unattended'], 'ADR-010 decision 3'],
    committed: [['unattended'], 'a committed hail is not withdrawn: ADR-010 decision 3'],
    'committed, unattended': [[], ALREADY_UNATTENDED],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  'console-ack': {
    none: [[], NO_HAIL],
    registered: [[], NOT_SIGNALLED],
    left: [[], NOT_SIGNALLED],
    present: [[], NOT_SIGNALLED],
    'present, unattended': [[], NOT_SIGNALLED],
    eligible: [[], NOT_SIGNALLED],
    'eligible, unattended': [[], NOT_SIGNALLED],
    'eligible, stale': [[], NOT_SIGNALLED],
    committed: [['confirmed'], CONFIRMED],
    'committed, unattended': [['confirmed'], `${CONFIRMED}; Unattended carries on, ADR-010 decision 3`],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  tick: {
    none: [[], NO_HAIL],
    registered: [[], NOT_ELIGIBLE],
    left: [[], NOT_ELIGIBLE],
    present: [[], NOT_ELIGIBLE],
    'present, unattended': [[], NOT_ELIGIBLE],
    eligible: [[], 'the commit instant is still to come: ADR-037 decision 1'],
    'eligible, unattended': [[], 'the commit instant is still to come: ADR-037 decision 1'],
    'eligible, stale': [['committed'], 'a fresh report past the commit instant commits at once: ADR-023; ADR-037 decision 1'],
    committed: [[], NO_RERESOLVE],
    'committed, unattended': [[], NO_RERESOLVE],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], `${NO_HAIL}; the tick ends staleness: ${FEED_RULE}`, [(s, e) => s.at(e, register), ['registered']]],
  },
  'tick, too close': {
    none: [[], NO_HAIL],
    registered: [[], NOT_ELIGIBLE],
    left: [[], NOT_ELIGIBLE],
    present: [[], NOT_ELIGIBLE],
    'present, unattended': [[], NOT_ELIGIBLE],
    eligible: [['abandoned deadline'], 'the bus it resolved to: ADR-039 decision 3'],
    'eligible, unattended': [['abandoned deadline'], 'the bus it resolved to: ADR-039 decision 3; ADR-010 decision 3'],
    'eligible, stale': [['abandoned deadline'], 'a stale pick is resolved to: ADR-039, annotated 08-10-2026'],
    committed: [[], NO_RERESOLVE],
    'committed, unattended': [[], NO_RERESOLVE],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  'wakeup dwell': {
    none: [[], NO_HAIL],
    registered: [[], STALE_WAKEUP],
    left: [[], `void since the departure: ${STALE_WAKEUP}`],
    present: [['eligible'], 'FR4; ADR-041 decision 1'],
    'present, unattended': [['eligible'], 'an uncommitted hail carries on: ADR-010 decision 3; ADR-041 decision 1'],
    eligible: [[], STALE_WAKEUP],
    'eligible, unattended': [[], STALE_WAKEUP],
    'eligible, stale': [[], STALE_WAKEUP],
    committed: [[], STALE_WAKEUP],
    'committed, unattended': [[], STALE_WAKEUP],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  'wakeup commit': {
    none: [[], NO_HAIL],
    registered: [[], STALE_WAKEUP],
    left: [[], STALE_WAKEUP],
    present: [[], STALE_WAKEUP],
    'present, unattended': [[], STALE_WAKEUP],
    eligible: [['committed'], 'ADR-037 decision 1'],
    'eligible, unattended': [['committed'], 'an uncommitted hail still commits: ADR-010 decision 3'],
    'eligible, stale': [[], STALE_WAKEUP],
    committed: [[], `a hail commits once; ${STALE_WAKEUP}`],
    'committed, unattended': [[], `a hail commits once; ${STALE_WAKEUP}`],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  'wakeup deadline': {
    none: [[], NO_HAIL],
    registered: [[], STALE_WAKEUP],
    left: [[], STALE_WAKEUP],
    present: [[], STALE_WAKEUP],
    'present, unattended': [[], STALE_WAKEUP],
    eligible: [[], STALE_WAKEUP],
    'eligible, unattended': [[], STALE_WAKEUP],
    'eligible, stale': [['abandoned stale'], 'still stale at its deadline: ADR-023, decided 07-10-2026'],
    // Its deadline wakeup, at T + 72.4 s, would tell it unacknowledged (#61), but no tick comes after T + 20 s.
    committed: [['abandoned feed', 'retract s1 feed'], `the feed goes stale at T + 50 s, first; ${FEED}`],
    'committed, unattended': [['abandoned feed', 'retract s1 feed'], `the feed goes stale at T + 50 s, first; ${FEED}`],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
  'wakeup feed': {
    none: [[], NO_HAIL],
    registered: [['abandoned feed'], FEED],
    left: [['abandoned feed'], FEED],
    present: [['eligible', 'abandoned feed'], `the dwell ends at T + 30 s, 1 ms before; ${FEED}`],
    'present, unattended': [['eligible', 'abandoned feed'], `the dwell ends at T + 30 s, 1 ms before; ${FEED}`],
    eligible: [['committed', 'abandoned feed', 'retract s1 feed'], `its commit, at T + 42.4 s, comes first; ${FEED}, retracting its signal`],
    'eligible, unattended': [['committed', 'abandoned feed', 'retract s1 feed'], `its commit, at T + 42.4 s, comes first; ${FEED}, retracting its signal`],
    'eligible, stale': [['abandoned stale'], 'its deadline, T + 72.4 s, comes before the feed goes stale at T + 75 s: ADR-023, decided 07-10-2026'],
    committed: [['abandoned feed', 'retract s1 feed'], `${FEED}, retracting its signal`],
    'committed, unattended': [['abandoned feed', 'retract s1 feed'], `${FEED}, retracting its signal`],
    withdrawn: [[], ENDED],
    spent: [[], ENDED],
    abandoned: [[], ENDED],
    'feed stale': [[], NO_HAIL],
  },
};

// A record's kind, with the reason an abandonment gives.
const outcome = ({ kind, payload }: DecisionRecord) => (payload.reason ? `${kind} ${payload.reason}` : kind);

describe('T2: every lifecycle state against every event (#33)', () => {
  it.each(Object.entries(states))('reaches %s', (_, { trail, reach }) => {
    const s = service();
    reach(s);
    expect(s.records.map(outcome)).toEqual(trail);
  });

  for (const [event, row] of Object.entries(table)) {
    describe(event, () => {
      for (const [state, cell] of Object.entries(row)) {
        const [written, rule, next] = cell;
        it(`${state} writes [${written.join(', ')}]: ${rule}`, () => {
          const s = service();
          const e = states[state as State].reach(s);
          // Every commit hands SignalPort its signal, new or joined (#32, #35); a retraction (#38) is listed after the records.
          const step = (act: (s: Service, e: number) => void) => {
            const [records, signals, retractions] = [s.records.length, s.signals.length, s.retractions().length];
            act(s, e);
            const added = s.records.slice(records);
            expect(s.signals.length - signals).toBe(added.filter((r) => r.kind === 'committed').length);
            return [...added.map(outcome), ...s.retractions().slice(retractions)];
          };
          expect(step(events[event as keyof typeof events])).toEqual(written);
          if (next) expect(step(next[0])).toEqual(next[1]);
        });
      }
    });
  }
});
