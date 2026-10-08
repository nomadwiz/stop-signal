import { describe, expect, it } from 'vitest';
import type { Json } from '../../hail-core/src/trace.ts';
import { dwell, hails, m1 } from './m1.ts';
import type { Scenario } from './scenarios.ts';

const T = 1_790_000_000_000;
// One decision record as the replay writes it, a JSON line in ADR-017's key order.
let seq = 0;
const line = (at: number, kind: string, hailId: string, vehicleId: string | null = null, payload: { [key: string]: Json } = {}) =>
  JSON.stringify({ seq: ++seq, at, kind, hailId, vehicleId, payload });
const registered = (at: number, hailId: string, routeId: string) => line(at, 'registered', hailId, null, { stopId: 'S', routeId, leadTimeS: 0 });
const committed = (at: number, hailId: string, vehicleId: string, deadline: number | null) => line(at, 'committed', hailId, vehicleId, { deadline, signalId: `s-${hailId}` });

const call = (routeId: string, vehicleId: string, atArrivalClass: 'single' | 'queued') =>
  ({ tripId: `trip-${routeId}`, vehicleId, routeId, stopSequence: 3, at: T + 300_000, atArrival: null, atArrivalClass });
const scenario = (cls: 'single' | 'queued', calls: Scenario['calls'], n = 1): Scenario =>
  ({ stopId: 'S', day: '20261003', dS: 17.4, n, class: cls, group: 'single-on-both', calls, events: [] });

describe('hails', () => {
  it("reads each hail's route, target call, eligibility, commit, ending and skips from its decision log", () => {
    const s = scenario('queued', [call('R', 'V1', 'queued'), call('Q', 'V2', 'queued')]);
    const log = [
      registered(T, 'h1', 'R'),
      line(T, 'skipped', 'h1', null, { candidates: ['V1'] }),
      line(T, 'present', 'h1'),
      registered(T, 'h2', 'Q'),
      line(T, 'present', 'h2'),
      line(T + 30_000, 'eligible', 'h1'),
      line(T + 30_000, 'skipped', 'h1', null, { candidates: ['V7'] }),
      line(T + 30_000, 'eligible', 'h2'),
      committed(T + 30_000, 'h2', 'V2', T + 50_000),
      line(T + 90_000, 'abandoned', 'h1', 'V9', { reason: 'stale' }),
    ];

    expect(hails(s, log)).toEqual([
      {
        routeId: 'R', target: s.calls[0], registered: T, eligible: T + 30_000, abandoned: 'stale',
        skipped: [{ at: T, candidates: ['V1'] }, { at: T + 30_000, candidates: ['V7'] }],
      },
      { routeId: 'Q', target: s.calls[1], registered: T, eligible: T + 30_000, committed: { at: T + 30_000, vehicleId: 'V2', deadline: T + 50_000 }, skipped: [] },
    ]);
  });
});

describe('m1', () => {
  it("scores each passenger group's commit against its target call, per call, in ADR-034's three groups", () => {
    const built = [
      // Queued on both, and V1 called: right.
      scenario('queued', [call('R', 'V1', 'queued')]),
      // Single on both, but V9 called: the commit on V1 is wrong.
      scenario('single', [call('R', 'V9', 'single')]),
      // Disputed, and abandoned: no commit.
      scenario('single', [call('Y', 'V8', 'queued')]),
    ];
    const logs = [
      [registered(T, 'h1', 'R'), committed(T + 60_000, 'h1', 'V1', T + 90_000)],
      [registered(T, 'h1', 'R'), committed(T + 60_000, 'h1', 'V1', null)],
      [registered(T, 'h1', 'Y'), line(T + 60_000, 'abandoned', 'h1', 'V8', { reason: 'deadline' })],
    ];

    expect(m1(built, logs)).toEqual({
      'single-on-both': { calls: 1, right: 0, wrong: 1, none: 0 },
      'queued-on-both': { calls: 1, right: 1, wrong: 0, none: 0 },
      disputed: { calls: 1, right: 0, wrong: 0, none: 1 },
    });
  });

  it('counts a call once however many passengers want it, scoring its first hail', () => {
    const five = scenario('single', [call('R', 'V1', 'single')], 5);
    const log = ['h1', 'h2', 'h3', 'h4', 'h5'].flatMap((h) => [registered(T, h, 'R'), committed(T + 60_000, h, 'V1', T + 90_000)]);

    expect(m1([five], [log])['single-on-both']).toEqual({ calls: 1, right: 1, wrong: 0, none: 0 });
  });
});

describe('dwell', () => {
  it("counts hails eligible after their commit instant, after their target's deadline, and registered with it already inside its stopping distance (ADR-041 decision 3, ADR-039)", () => {
    const s = scenario('queued', [call('R', 'V1', 'queued'), call('Q', 'V2', 'queued'), call('P', 'V3', 'queued'), call('O', 'V4', 'queued')]);
    const log = [
      // h1 commits the instant it becomes eligible, on a deadline: eligible after its commit instant.
      registered(T, 'h1', 'R'),
      line(T + 30_000, 'eligible', 'h1'),
      committed(T + 30_000, 'h1', 'V1', T + 50_000),
      // h2 skips its target the instant it becomes eligible: eligible after its deadline.
      registered(T, 'h2', 'Q'),
      line(T + 30_000, 'eligible', 'h2'),
      line(T + 30_000, 'skipped', 'h2', null, { candidates: ['V8', 'V2'] }),
      // h3 commits at once on a stopped vehicle, which has no deadline, and skips another route's bus: neither counts.
      registered(T, 'h3', 'P'),
      line(T + 30_000, 'eligible', 'h3'),
      line(T + 30_000, 'skipped', 'h3', null, { candidates: ['V9'] }),
      committed(T + 30_000, 'h3', 'V3', null),
      // h4 skips its target as it registers: registered with it already inside its stopping distance.
      registered(T, 'h4', 'O'),
      line(T, 'skipped', 'h4', null, { candidates: ['V4'] }),
    ];

    expect(dwell(hails(s, log))).toEqual({ hails: 4, eligible: 3, afterCommitInstant: 1, afterDeadline: 1, registeredInside: 1 });
  });
});
