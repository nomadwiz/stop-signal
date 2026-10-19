import { describe, expect, it } from 'vitest';
import type { Json } from '../../hail-core/src/trace.ts';
import { m2, m3, m4c, report } from './measures.ts';
import type { Scenario } from './scenarios.ts';

const T = 1_790_000_000_000;
// One decision record as the replay writes it, a JSON line in ADR-017's key order.
let seq = 0;
const line = (at: number, kind: string, hailId: string, vehicleId: string | null = null, payload: { [key: string]: Json } = {}) =>
  JSON.stringify({ seq: ++seq, at, kind, hailId, vehicleId, payload });
const registered = (hailId: string, routeId: string) => line(T, 'registered', hailId, null, { stopId: 'S', routeId, leadTimeS: 0 });
const committed = (at: number, hailId: string, vehicleId: string, deadline: number | null) =>
  line(at, 'committed', hailId, vehicleId, { deadline, signalId: `s-${hailId}` });

// Each call is at T + 300 s, the oracle's call time for its target (ADR-018 decision 7).
const call = (routeId: string, vehicleId: string, atArrivalClass: 'single' | 'queued') =>
  ({ tripId: `trip-${routeId}`, vehicleId, routeId, stopSequence: 3, at: T + 300_000, atArrival: null, atArrivalClass });
const scenario = (cls: 'single' | 'queued', calls: Scenario['calls'], n = 1): Scenario =>
  ({ stopId: 'S', day: '20261003', dS: 17.4, n, class: cls, group: `${cls}-on-both`, calls, events: [] });

describe('report', () => {
  const run = {
    built: [scenario('single', [call('R', 'V1', 'single')]), scenario('queued', [call('Q', 'V2', 'queued')])],
    logs: [
      // Right, told before V1 calls at T + 300 s.
      [registered('h1', 'R'), committed(T + 60_000, 'h1', 'V1', T + 90_000), line(T + 90_000, 'unacknowledged', 'h1', 'V1')],
      // Wrong, told nothing, and Unattended at its deadline.
      [registered('h1', 'Q'), committed(T + 60_000, 'h1', 'V9', T + 90_000), line(T + 70_000, 'unattended', 'h1')],
    ],
  };

  it("gives M1 per D as ADR-034's table, and each group against its target (ADR-034, ADR-037 decision 2)", () => {
    const lines = report(run, run);

    expect(lines).toContain('| Single on both | 1 | 1 / 1 = 100.0% |');
    expect(lines).toContain('| Queued on both | 1 | 0 / 1 = 0.0% |');
    expect(lines).toContain('| Disputed (class differs with AT\'s arrival times) | 0 | 0 / 0 = — |');
    expect(lines).toContain('| M1, single on both | 100.0% | ≥ 95% | yes |');
    expect(lines).toContain('| M1, queued on both | 0.0% | ≥ 80% | no |');
  });

  it('gives M2 to M4c each against its m1-revised.md §7.3 target, M4a to M4c over the N = 5 approaches', () => {
    // A third hail, committed on a stopped vehicle and spent as V3 calls: in M3, told nothing; out of M2, no deadline.
    const n1 = {
      built: [...run.built, scenario('single', [call('S', 'V3', 'single')])],
      logs: [...run.logs, [registered('h1', 'S'), committed(T + 60_000, 'h1', 'V3', null), line(T + 300_000, 'spent', 'h1')]],
    };
    const lines = report(n1, run);

    expect(lines).toContain("| M2, worst tenth's margin before the deadline | 30.000 s; 2 of 2 signals early | Worst tenth still early: > 0 s | yes |");
    expect(lines).toContain('| M3, told the outcome before the bus called | 1 / 3 = 33.3% | ≥ 99% | no |');
    expect(lines).toContain('Within M3: 1 hails committed on a stopped vehicle were spent before their run stopped calling, so were told no outcome (ADR-032 and ADR-038, annotated 09-10-2026).');
    expect(lines).toContain('M2 leaves out the 1 commits on a stopped vehicle because they have no deadline, so no margin before one (ADR-037).');
    expect(lines).toContain("M3's 2 not told before the bus called: 1 committed on a stopped vehicle, told nothing; 1 committed with a deadline and spent before it, told nothing; 0 never committed or abandoned; 0 told after the call.");
    expect(lines).toContain('| M4a, signals per approach | 1 on 2 of 2 approaches | Exactly 1 | yes |');
    expect(lines).toContain('| M4b, approaches with a correction | 0 / 2 = 0.0% | ≤ 10% | yes |');
    expect(lines).toContain('| M4c, approaches reaching their deadline in Unattended | 1 / 2 = 50.0% | ≤ 5% | no |');
  });

  it('meets M4b at a correction on 1 approach in 10, and not at 2 in 10', () => {
    // Each log is one approach, or two where its hail moves from V1 to V2, the move a correction (#39).
    const once = [registered('h1', 'R'), committed(T + 60_000, 'h1', 'V1', T + 90_000)];
    const moved = [...once, committed(T + 70_000, 'h1', 'V2', T + 95_000)];
    const n5 = (corrections: number) => ({ built: run.built, logs: [...Array(10 - 2 * corrections).fill(once), ...Array(corrections).fill(moved)] });

    expect(report(run, n5(1))).toContain('| M4b, approaches with a correction | 1 / 10 = 10.0% | ≤ 10% | yes |');
    expect(report(run, n5(2))).toContain('| M4b, approaches with a correction | 2 / 10 = 20.0% | ≤ 10% | no |');
  });
});

describe('m2', () => {
  it("takes the worst tenth's margin before each signal's deadline, counting a commit with no deadline apart (m1-revised.md §7.3)", () => {
    // Ten signals 1 s to 10 s early, and one on a stopped vehicle, which has no deadline (ADR-037).
    const log = [...Array(10).keys()].map((i) => committed(T, `h${i}`, 'V1', T + (i + 1) * 1_000)).concat(committed(T, 'h10', 'V2', null));

    expect(m2([log])).toEqual({ signals: 10, early: 10, worstTenthMs: 1_000, noDeadline: 1 });
  });
});

describe('m3', () => {
  it('counts hails told an outcome before their bus called, naming stopped-vehicle hails spent untold (ADR-032, annotated 09-10-2026)', () => {
    const s = scenario('queued', [call('A', 'V1', 'queued'), call('B', 'V2', 'queued'), call('C', 'V3', 'queued'), call('D', 'V4', 'queued'), call('E', 'V5', 'queued')]);
    const log = [
      // Told unacknowledged at its deadline, before V1 called at T + 300 s.
      registered('h1', 'A'), committed(T + 60_000, 'h1', 'V1', T + 90_000), line(T + 90_000, 'unacknowledged', 'h1', 'V1'),
      // Told cannot hail before V2 called.
      registered('h2', 'B'), line(T + 100_000, 'abandoned', 'h2', 'V2', { reason: 'deadline' }),
      // Committed on a stopped vehicle and spent before it passed: told nothing, named apart.
      registered('h3', 'C'), committed(T + 60_000, 'h3', 'V3', null), line(T + 300_000, 'spent', 'h3'),
      // Committed, then spent when V4 called, before its deadline: told nothing.
      registered('h4', 'D'), committed(T + 280_000, 'h4', 'V4', T + 310_000), line(T + 300_000, 'spent', 'h4'),
      // Never committed nor abandoned: told nothing.
      registered('h5', 'E'),
    ];

    expect(m3([s], [log])).toEqual({ hails: 5, before: 2, after: 0, stopped: 1, committedUntold: 1, uncommitted: 1 });
  });
});

describe('m4c', () => {
  it('counts approaches whose hail reached its deadline in Unattended, not one the passenger left first (ADR-010 decision 6, ADR-040 decision 5)', () => {
    const log = [
      // Unattended, and still live at its deadline: counted.
      registered('h1', 'A'), committed(T + 60_000, 'h1', 'V1', T + 90_000), line(T + 70_000, 'unattended', 'h1'), line(T + 90_000, 'unacknowledged', 'h1', 'V1'),
      // Unattended, but spent before its deadline: not counted.
      registered('h2', 'B'), committed(T + 60_000, 'h2', 'V2', T + 90_000), line(T + 70_000, 'unattended', 'h2'), line(T + 80_000, 'spent', 'h2'),
      // Unattended, then a reported departure and a return before it commits: the departure ended Unattended.
      registered('h3', 'C'), line(T + 10_000, 'unattended', 'h3'), line(T + 20_000, 'left', 'h3'), line(T + 40_000, 'returned', 'h3'),
      committed(T + 60_000, 'h3', 'V3', T + 90_000),
    ];

    expect(m4c(log)).toBe(1);
  });
});
