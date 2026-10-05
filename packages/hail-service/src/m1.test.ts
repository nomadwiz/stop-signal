import { describe, expect, it } from 'vitest';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import type { StaticIndex } from './gtfs-static.ts';
import { commits, m1, type Snapshot } from './m1.ts';
import type { Scenario } from './scenarios.ts';

const T = 1_790_000_000_000;
const DAY = '20261003';
// A straight road east along one latitude. Stop S lies 1,335 m along it, and its previous stop P 356 m before S,
// so a stopped vehicle is due within 356 + 50 = 406 m (ADR-037's [DECIDED:05-10-2026] on a stopped vehicle).
const LAT = -36.85;
const KX = 6_371_000 * (Math.PI / 180) * Math.cos((LAT * Math.PI) / 180);
const S = { lat: LAT, lon: 174.775 };
const before = (m: number) => ({ lat: LAT, lon: S.lon - m / KX });
const stopTimes = [{ stopId: 'O', sequence: 1 }, { stopId: 'P', sequence: 2 }, { stopId: 'S', sequence: 3 }, { stopId: 'Z', sequence: 4 }];
const index = {
  day: DAY,
  previousDay: '20261002',
  stops: new Map([['S', S], ['P', { lat: LAT, lon: 174.771 }]]),
  // A1 and A2 run route R; B1 runs route Q along the same road; F1, route F, starts at S.
  trips: new Map([
    ...[['A1', 'R'], ['A2', 'R'], ['B1', 'Q']].map(([id, routeId]) => [id, { id, routeId, shapeId: 'road', stopTimes }] as const),
    ['F1', { id: 'F1', routeId: 'F', shapeId: 'road', stopTimes: [{ stopId: 'S', sequence: 1 }, { stopId: 'Z', sequence: 2 }] }],
  ]),
  lateTrips: new Map(),
  tripsAtStop: new Map([['S', ['A1', 'A2', 'B1', 'F1']]]),
  shapes: new Map([['road', [{ lat: LAT, lon: 174.76, sequence: 1 }, { lat: LAT, lon: 174.78, sequence: 2 }]]]),
} as unknown as StaticIndex;
// A report from vehicle v on trip, m metres before S, fixed at the instant at.
const report = (v: string, tripId: string, m: number, at: number): VehicleReport => ({ vehicleId: v, tripId, startDate: DAY, ...before(m), at });

describe('commits', () => {
  it('commits one feed interval before the deadline, on the nearest calling vehicle of the route (ADR-036, ADR-037)', () => {
    // V1 runs at 10 m/s; Q's V3 is nearer the stop but on another route; R's V2 is further back.
    const snaps: Snapshot[] = [-20_000, 0, 20_000].map((dt) => ({
      at: T + dt,
      reports: [report('V1', 'A1', 600 - dt / 100, T + dt), report('V2', 'A2', 1300 - dt / 100, T + dt), report('V3', 'B1', 200 - dt / 100, T + dt)],
    }));

    // At T + 20 s V1 is 400 m out at 10 m/s: the stopping distance is 10 × 2 + 10² / (2 × 0.9) = 75.6 m,
    // so the deadline is 32.4 s later and the commit 2.4 s later.
    const c = commits(index, 'S', snaps)('R', T - 20_000, T + 60_000);
    expect(c?.vehicleId).toBe('V1');
    expect(c?.at).toBeCloseTo(T + 22_444.4, 0);
  });

  it("does not commit on a stale prediction, and commits on the next report instead (ADR-023's and ADR-037's [DECIDED:05-10-2026])", () => {
    // V1's latest fix is 40 s old at T, so its commit instant, T + 2.4 s, falls on a stale prediction.
    const old = [report('V1', 'A1', 1000, T - 60_000), report('V1', 'A1', 800, T - 40_000)];
    const snaps: Snapshot[] = [
      { at: T - 60_000, reports: [old[0]] },
      { at: T - 40_000, reports: [old[1]] },
      { at: T, reports: [old[1]] },
      { at: T + 5_000, reports: [report('V1', 'A1', 350, T + 5_000)] },
    ];

    expect(commits(index, 'S', snaps)('R', T - 60_000, T + 3_000)).toBeNull();
    expect(commits(index, 'S', snaps)('R', T - 60_000, T + 30_000)).toEqual({ vehicleId: 'V1', at: T + 5_000 });
  });

  it("commits at once on a stopped vehicle within its previous stop's distance plus CALL_RADIUS_M (ADR-037's [DECIDED:05-10-2026])", () => {
    const snaps: Snapshot[] = [-20_000, 0].map((dt) => ({ at: T + dt, reports: [report('V1', 'A1', 380, T + dt)] }));

    expect(commits(index, 'S', snaps)('R', T - 20_000, T + 60_000)).toEqual({ vehicleId: 'V1', at: T });
  });

  it("waits on a stopped vehicle beyond that reach (ADR-037's [DECIDED:05-10-2026])", () => {
    const snaps: Snapshot[] = [-20_000, 0].map((dt) => ({ at: T + dt, reports: [report('V1', 'A1', 450, T + dt)] }));

    expect(commits(index, 'S', snaps)('R', T - 20_000, T + 60_000)).toBeNull();
  });

  it("waits on a stale stopped vehicle within that reach, and commits on its next fresh report (ADR-037's [DECIDED:05-10-2026])", () => {
    // V1 stands 380 m out; at T its latest fix is 40 s old.
    const snaps: Snapshot[] = [
      { at: T - 60_000, reports: [report('V1', 'A1', 380, T - 60_000)] },
      { at: T - 40_000, reports: [report('V1', 'A1', 380, T - 40_000)] },
      { at: T, reports: [report('V1', 'A1', 380, T - 40_000)] },
      { at: T + 10_000, reports: [report('V1', 'A1', 380, T + 10_000)] },
    ];

    expect(commits(index, 'S', snaps)('R', T, T + 5_000)).toBeNull();
    expect(commits(index, 'S', snaps)('R', T, T + 30_000)).toEqual({ vehicleId: 'V1', at: T + 10_000 });
  });

  it("gives a trip whose first stop is the stop no stopped-vehicle rule (ADR-037's [DECIDED:05-10-2026])", () => {
    const snaps: Snapshot[] = [-20_000, 0].map((dt) => ({ at: T + dt, reports: [report('V1', 'F1', 10, T + dt)] }));

    expect(commits(index, 'S', snaps)('F', T - 20_000, T + 60_000)).toBeNull();
  });

  it('commits nothing once the deadline has passed (ADR-023)', () => {
    // 50 m out at 12.5 m/s, inside the 111.8 m stopping distance.
    const snaps: Snapshot[] = [{ at: T - 20_000, reports: [report('V1', 'A1', 300, T - 20_000)] }, { at: T, reports: [report('V1', 'A1', 50, T)] }];

    expect(commits(index, 'S', snaps)('R', T - 20_000, T + 5_000)).toBeNull();
  });

  it("carries each fix's match along the shape to the next, so a loop's second pass stays the second pass (ADR-022 decision 5)", () => {
    // A road driven twice, 20 m apart: 1,000 m east, 20 m north, 1,000 m back west, then on west to S, 2,320 m along.
    const at = (north: number, east: number) => ({ lat: LAT + north / (6_371_000 * (Math.PI / 180)), lon: 174.76 + east / KX });
    const loopIndex = {
      ...index,
      stops: new Map([['S', at(20, -300)], ['P', at(20, 300)]]),
      trips: new Map([['A1', { id: 'A1', routeId: 'R', shapeId: 'loop', stopTimes: [{ stopId: 'P', sequence: 1 }, { stopId: 'S', sequence: 2 }] }]]),
      tripsAtStop: new Map([['S', ['A1']]]),
      shapes: new Map([['loop', [at(0, 0), at(0, 1_000), at(20, 1_000), at(20, 0), at(20, -500)]]]),
    } as unknown as StaticIndex;
    // V1 runs west on the second pass at 10 m/s; its middle fix strays 15 m south, nearer the first pass.
    const fix = (north: number, east: number, t: number): VehicleReport => ({ vehicleId: 'V1', tripId: 'A1', startDate: DAY, ...at(north, east), at: t });
    const snaps: Snapshot[] = [fix(20, 400, T - 40_000), fix(5, 200, T - 20_000), fix(20, 0, T)].map((r) => ({ at: r.at, reports: [r] }));

    // At T V1 is 300 m out at 10 m/s, inside a deadline − 30 s that has passed, so it commits at once.
    expect(commits(loopIndex, 'S', snaps)('R', T, T + 60_000)).toEqual({ vehicleId: 'V1', at: T });
  });
});

describe('m1', () => {
  it("scores each passenger group's commit against its target call, per call, in ADR-034's three groups", () => {
    const snaps: Snapshot[] = [-20_000, 0, 20_000].map((dt) => ({ at: T + dt, reports: [report('V1', 'A1', 600 - dt / 100, T + dt)] }));
    const call = (routeId: string, vehicleId: string, cls: 'single' | 'queued') => ({ tripId: 'A1', vehicleId, routeId, stopSequence: 3, at: T + 60_000, atArrival: null, atArrivalClass: cls });
    const register = (routeId: string) => ({ at: T - 20_000, event: { kind: 'register' as const, handle: `h-${routeId}`, stopId: 'S', routeId, leadTimeS: 0 } });
    const scenario = (cls: 'single' | 'queued', calls: Scenario['calls']): Scenario => ({
      stopId: 'S', day: DAY, dS: 17.4, n: 1, class: cls, group: 'single-on-both', calls, events: calls.map((c) => register(c.routeId)),
    });

    const built = [
      // Queued on both, and V1 called: right.
      scenario('queued', [call('R', 'V1', 'queued')]),
      // Single on both, but V9 called: the commit on V1 is wrong.
      scenario('single', [call('R', 'V9', 'single')]),
      // Disputed, on a route with no vehicle: no commit.
      scenario('single', [call('Y', 'V8', 'queued')]),
    ];

    expect(m1(index, 'S', snaps, built)).toEqual({
      'single-on-both': { calls: 1, right: 0, wrong: 1, none: 0 },
      'queued-on-both': { calls: 1, right: 1, wrong: 0, none: 0 },
      disputed: { calls: 1, right: 0, wrong: 0, none: 1 },
    });
  });

  it('counts a call once however many passengers want it, since they resolve alike', () => {
    const snaps: Snapshot[] = [-20_000, 0, 20_000].map((dt) => ({ at: T + dt, reports: [report('V1', 'A1', 600 - dt / 100, T + dt)] }));
    const register = (handle: string) => ({ at: T - 20_000, event: { kind: 'register' as const, handle, stopId: 'S', routeId: 'R', leadTimeS: 0 } });
    const five: Scenario = {
      stopId: 'S', day: DAY, dS: 17.4, n: 5, class: 'single', group: 'single-on-both',
      calls: [{ tripId: 'A1', vehicleId: 'V1', routeId: 'R', stopSequence: 3, at: T + 60_000, atArrival: null, atArrivalClass: 'single' }],
      events: ['h1', 'h2', 'h3', 'h4', 'h5'].map(register),
    };

    expect(m1(index, 'S', snaps, [five])['single-on-both']).toEqual({ calls: 1, right: 1, wrong: 0, none: 0 });
  });
});
