import { describe, expect, it } from 'vitest';
import type { ServiceDay } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { sweep } from './sweep.ts';

const T = 1_790_000_000_000;
const DAY = '20261003';
// replay.test.ts's straight road east along one latitude, stop S 1,335 m along it.
const LAT = -36.85;
const KX = 6_371_000 * (Math.PI / 180) * Math.cos((LAT * Math.PI) / 180);
const S = { lat: LAT, lon: 174.775 };
const stopTimes = [{ stopId: 'P' }, { stopId: 'S' }];
const road: ServiceDay = {
  day: DAY,
  previousDay: '20261002',
  stops: new Map([['S', S], ['P', { lat: LAT, lon: 174.771 }]]),
  trips: new Map([['A1', { routeId: 'R', shapeId: 'road', stopTimes }], ['B1', { routeId: 'Q', shapeId: 'road', stopTimes }]]),
  lateTrips: new Map(),
  tripsAtStop: new Map([['S', ['A1', 'B1']]]),
  shapes: new Map([['road', [{ lat: LAT, lon: 174.76 }, { lat: LAT, lon: 174.78 }]]]),
};
const report = (m: number, at: number, vehicleId = 'V1', tripId = 'A1'): VehicleReport => ({ vehicleId, tripId, startDate: DAY, lat: LAT, lon: S.lon - m / KX, at });
const HANDLE = '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34';
const register: HailEvent = { kind: 'register', handle: HANDLE, stopId: 'S', routeId: 'R', leadTimeS: 0 };
const start: HailEvent = { kind: 'presence-start', handle: HANDLE, stopId: 'S' };

describe('sweep', () => {
  it('replays at each deceleration a and gives M2 there, with the range of D = 2.0 s + v / a its signals span (ADR-023 decision 2)', () => {
    // V1 runs at 10 m/s, reporting every 20 s from 1,100 m out: each a commits one signal one feed interval before its
    // own deadline, and D is 2 + 10 / 0.9 = 13.111 s at the gentlest braking and 2 + 10 / 1.47 = 8.803 s at the firmest.
    const snaps = [0, 20_000, 40_000, 60_000, 80_000, 100_000].map((dt) => ({ at: T + dt, reports: [report(1_100 - dt / 100, T + dt)] }));
    const events = [{ at: T - 60_000, event: register }, { at: T - 60_000, event: start }];

    const [gentle, firm] = sweep(road, snaps, [events], [0.9, 1.47]);

    expect(gentle).toMatchObject({ a: 0.9, m2: { signals: 1, early: 1, noDeadline: 0 } });
    expect(gentle.m2.worstTenthMs).toBeCloseTo(30_000, 0);
    expect(gentle.dS[0]).toBeCloseTo(13.111, 3);
    expect(gentle.dS[1]).toBeCloseTo(13.111, 3);
    expect(firm).toMatchObject({ a: 1.47, m2: { signals: 1, early: 1, noDeadline: 0 } });
    expect(firm.dS[0]).toBeCloseTo(8.803, 3);
    expect(firm.dS[1]).toBeCloseTo(8.803, 3);
  });

  it('leaves out of D a commit with no deadline and a hail that joins a live signal, which M2 still counts', () => {
    // V1 runs at 10 m/s on route R, as above, and V2 on route Q stands 300 m out, within reach (ADR-037). Two R
    // passengers commit on V1 together, the second joining the first's signal; one Q passenger commits on V2 at once.
    const snaps = [0, 20_000, 40_000, 60_000, 80_000, 100_000].map((dt) => ({ at: T + dt, reports: [report(1_100 - dt / 100, T + dt), report(300, T + dt, 'V2', 'B1')] }));
    const second = '7a1d4e2b-5c3f-4a8e-9b6d-2e4f6a8c0b13';
    const third = 'c4e8a2f6-1b3d-4c5e-8f7a-9d0b2c4e6f81';
    const twoOnR = [register, start, { ...register, handle: second }, { ...start, handle: second }].map((event) => ({ at: T - 60_000, event }));
    const oneOnQ = [{ ...register, handle: third, routeId: 'Q' }, { ...start, handle: third }].map((event) => ({ at: T - 60_000, event }));

    const [only] = sweep(road, snaps, [twoOnR, oneOnQ], [0.9]);

    expect(only).toMatchObject({ m2: { signals: 2, early: 2, noDeadline: 1 }, spanned: 1 });
    expect(only.dS[0]).toBeCloseTo(13.111, 3);
    expect(only.dS[1]).toBeCloseTo(13.111, 3);
  });
});
