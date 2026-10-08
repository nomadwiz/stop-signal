// S9's replay harness (#16, QR9, T7): drives the production hail coordinator through recorded snapshots and a scenario's
// events on a clock set to each input's time, with the real loop and scheduler, and returns the decision log it writes.
import { hailCoordinator, type ServiceDay } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { recorder } from '../../hail-core/src/trace.ts';

// The service's values, as main.ts sets them: ADR-023 decision 2's deceleration and ADR-041's dwell.
const DECEL_MPS2 = 0.9;
const DWELL_MS = 30_000;

// A replay input: an event that crosses the seam, at the instant it arrives. A snapshot is a tick at its capture time,
// and a scenario's events are already in this shape (ADR-035 decision 5).
export interface Timed { at: number; event: HailEvent }

// The snapshots as ticks, merged with the events in time order. The sort is stable, so on a tie the tick goes first.
export function inputs(snaps: readonly { at: number; reports: VehicleReport[] }[], events: readonly Timed[]): Timed[] {
  const ticks = snaps.map(({ at, reports }): Timed => ({ at, event: { kind: 'tick', reports } }));
  return [...ticks, ...events].sort((a, b) => a.at - b.at);
}

// One fresh coordinator applies every input through submit(), as the live adapters do (ADR-028 decision 1). Before each
// input, every wakeup due by then fires with the clock at its own t, as the live timer fires it to within 100 ms, so a
// replay never runs a commit late by the gap to the next snapshot. Signals go nowhere: the log is what T7 compares.
// Each line is JSON.stringify of the record, as main.ts writes it, keys in ADR-017's order.
export function replay(timetable: ServiceDay, timed: readonly Timed[]): string[] {
  let now = -Infinity;
  const clock = { now: () => now };
  const log: string[] = [];
  const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
  const apply = hailCoordinator({
    clock,
    record: recorder(clock, { append: (r) => log.push(JSON.stringify(r)) }),
    signals: { signal: () => {}, retract: () => {} },
    schedule: wakeups.at,
    timetable,
    decelMps2: DECEL_MPS2,
    dwellMs: DWELL_MS,
  });
  for (const { at, event } of timed) {
    for (let t = wakeups.next(); t <= at; t = wakeups.next()) {
      now = t;
      wakeups.wake();
    }
    now = at;
    wakeups.submit(event);
  }
  return log;
}
