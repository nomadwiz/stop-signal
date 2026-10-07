// C2: runs each hail through its lifecycle state machine, from register to commit (#32, FR7, FR13; Milestone 2's
// Figure 5.4). One function applies every event the loop hands it, in queue order (ADR-002), and writes exactly one
// decision record per transition (ADR-017).
import type { Clock } from './clock.ts';
import { signalDeadline } from './deadline.ts';
import type { HailEvent } from './events.ts';
import { FEED_INTERVAL_MS, predict, type Point } from './predict.ts';
import { callingAt, type Timetable, type VehicleReport } from './resolve.ts';
import type { SignalPort } from './signal.ts';
import type { Json, recorder } from './trace.ts';

// The service day the coordinator resolves against. hail-service's StaticIndex satisfies it.
export interface ServiceDay extends Timetable {
  trips: ReadonlyMap<string, Trip>;
  lateTrips: ReadonlyMap<string, Trip>;
  stops: ReadonlyMap<string, Point>;
  shapes: ReadonlyMap<string, Point[]>;
}
interface Trip { routeId: string; shapeId: string; stopTimes: readonly { stopId: string }[] }

// A live hail; a terminal transition deletes it. The handle is a credential (ADR-032 decision 5), so no record carries
// it: records name the hail by id. left is set by a reported departure with nothing delivered (ADR-040). wake is the one
// wakeup the hail now waits for; any other wakeup for it is stale and does nothing.
interface Hail {
  id: string;
  handle: string;
  stopId: string;
  routeId: string;
  state: 'registered' | 'present' | 'eligible' | 'committed';
  left: boolean;
  wake?: { at: number; purpose: Purpose };
}
type Purpose = Extract<HailEvent, { kind: 'wakeup' }>['purpose'];

// A vehicle run: one vehicle on one trip on one service day (ADR-025).
const run = ({ vehicleId, tripId, startDate }: VehicleReport) => JSON.stringify([vehicleId, tripId, startDate]);

export function hailCoordinator({ clock, record, signals, schedule, timetable, decelMps2, dwellMs }: {
  clock: Clock;
  record: ReturnType<typeof recorder>;
  signals: SignalPort;
  schedule: (at: number, event: HailEvent) => void;
  timetable: ServiceDay;
  decelMps2: number;
  dwellMs: number;
}): (event: HailEvent) => void {
  // Insertion order, so every event reaches the hails it names in the order they registered. Ids count up from h1,
  // so a replay numbers them alike.
  const hails = new Map<string, Hail>();
  let hailCount = 0;
  // When each passenger arrived at each stop, keyed [handle, stop]: presence is the passenger's, not a hail's, so a hail
  // registered while they wait counts its dwell from their arrival (ADR-040, decided 07-10-2026). Only a presence-end
  // removes an entry, so a lost connection keeps it and a return starts a fresh dwell (ADR-040 decision 2).
  const presence = new Map<string, number>();
  const here = ({ handle, stopId }: { handle: string; stopId: string }) => JSON.stringify([handle, stopId]);
  // Each vehicle run's latest two fixes, with each one's match along the trip's shape.
  // ponytail: one entry per vehicle run per service day, never dropped; drop a run once its trip ends if memory matters.
  const runs = new Map<string, { previous?: VehicleReport; previousAlongM?: number; latest: VehicleReport; latestAlongM: number }>();
  let signalCount = 0;
  const tripOf = (r: VehicleReport) => (r.startDate === timetable.previousDay ? timetable.lateTrips : timetable.trips).get(r.tripId ?? '');

  const note = (h: Hail, kind: string, payload: { [key: string]: Json } = {}, vehicleId: string | null = null) =>
    record({ kind, hailId: h.id, vehicleId, payload });
  const end = (h: Hail, kind: string, payload: { [key: string]: Json } = {}, vehicleId: string | null = null) => {
    note(h, kind, payload, vehicleId);
    hails.delete(h.id);
  };
  const wake = (h: Hail, purpose: Purpose, at: number) => {
    if (h.wake?.at === at && h.wake.purpose === purpose) return;
    h.wake = { at, purpose };
    schedule(at, { kind: 'wakeup', at, hailId: h.id, purpose });
  };

  // Present, then Eligible once the passenger has been at the stop for dwellMs since `since`.
  const arrive = (h: Hail, kind: 'present' | 'returned', since: number, now: number) => {
    h.state = 'present';
    note(h, kind);
    if (now >= since + dwellMs) eligible(h, now);
    else wake(h, 'dwell', since + dwellMs);
  };
  const eligible = (h: Hail, now: number) => {
    h.state = 'eligible';
    note(h, 'eligible');
    consider(h, now);
  };

  // The runs of the hail's route that call at its stop and have not passed it, nearest first (ADR-036), each with S2's
  // prediction at now. A run with one fix has no speed yet, and an unknown stop has no candidates.
  // ponytail: scans every run per eligible hail per event; index the runs by route if the live feed makes this slow.
  const calling = (h: Hail, now: number) => {
    const stop = timetable.stops.get(h.stopId);
    if (!stop) return [];
    const predicted = new Map<VehicleReport, ReturnType<typeof predict>>();
    for (const { previous, previousAlongM, latest } of runs.values()) {
      const trip = tripOf(latest)!;
      if (!previous || trip.routeId !== h.routeId) continue;
      predicted.set(latest, predict(timetable.shapes.get(trip.shapeId)!, stop, previous, latest, now, previousAlongM));
    }
    const candidates = [...predicted].map(([report, p]) => ({ report, distanceM: p.distanceM > 0 ? p.distanceM : null }));
    return callingAt(timetable, h.stopId, candidates).map(({ report }) => ({ report, ...predicted.get(report)! }));
  };

  // An eligible hail commits on the nearest calling vehicle one feed interval before its deadline, or at once if that
  // instant has passed (ADR-037 decision 1, annotated 07-10-2026); until then it waits on a commit wakeup, which any
  // later report that moves the deadline replaces. Run on eligibility, on every tick, and on its own wakeups.
  const consider = (h: Hail, now: number, purpose?: Purpose) => {
    const [p] = calling(h, now);
    if (!p) return;
    const d = signalDeadline(now, p.distanceM, p.speedMps, decelMps2);
    const vehicleId = p.report.vehicleId;
    // A stale prediction is no current estimate, so the hail never commits on it before the deadline, and waits for
    // the vehicle's next report until the deadline extrapolated from it (ADR-023, ADR-037 decision 1). Still stale
    // then, or already past it, the hail is abandoned (ADR-023, decided 07-10-2026).
    if (p.stale) {
      if (purpose === 'deadline' || (p.speedMps > 0 && !d)) return end(h, 'abandoned', { reason: 'stale' }, vehicleId);
      if (d) wake(h, 'deadline', d.deadline);
      return;
    }
    if (p.speedMps === 0) return;
    // The resolved vehicle is inside its stopping distance: abandoned, not passed to the next bus (ADR-039 decision 3).
    if (!d) return end(h, 'abandoned', { reason: 'deadline' }, vehicleId);
    if (now >= d.deadline - FEED_INTERVAL_MS) commit(h, vehicleId, d.deadline);
    else wake(h, 'commit', d.deadline - FEED_INTERVAL_MS);
  };
  // One Signal per hail until S4 (#35) aggregates them. Committed is Delivered: re-resolving and retracting are #38's.
  const commit = (h: Hail, vehicleId: string, deadline: number | null) => {
    h.state = 'committed';
    h.wake = undefined;
    const signalId = `s${++signalCount}`;
    note(h, 'committed', { deadline, signalId }, vehicleId);
    signals.signal({ id: signalId, vehicleId, stopId: h.stopId });
  };

  const registration = ({ handle, stopId, routeId }: { handle: string; stopId: string; routeId: string }) =>
    [...hails.values()].find((h) => h.handle === handle && h.stopId === stopId && h.routeId === routeId);

  // The live hails a presence event moves: every one of that passenger's at that stop.
  const atStop = (stop: { handle: string; stopId: string }) =>
    [...hails.values()].filter((h) => h.handle === stop.handle && h.stopId === stop.stopId);

  return (event) => {
    const now = clock.now();
    switch (event.kind) {
      case 'register': {
        if (registration(event)) return;
        const { handle, stopId, routeId, leadTimeS } = event;
        const h: Hail = { id: `h${++hailCount}`, handle, stopId, routeId, state: 'registered', left: false };
        hails.set(h.id, h);
        note(h, 'registered', { stopId, routeId, leadTimeS });
        const since = presence.get(here(h));
        if (since !== undefined) arrive(h, 'present', since, now);
        return;
      }
      case 'cancel': {
        // Only a cancel withdraws a hail (ADR-010 decision 2, ADR-040).
        const h = registration(event);
        if (h) end(h, 'withdrawn');
        return;
      }
      case 'presence-start': {
        if (!presence.has(here(event))) presence.set(here(event), now);
        for (const h of atStop(event)) if (h.state === 'registered') arrive(h, h.left ? 'returned' : 'present', presence.get(here(event))!, now);
        return;
      }
      case 'presence-end': {
        presence.delete(here(event));
        for (const h of atStop(event)) {
          // Back to Registered, uncommitted, until a return (ADR-040 decision 3).
          if (h.state === 'present' || h.state === 'eligible') {
            h.state = 'registered';
            h.left = true;
            h.wake = undefined;
            note(h, 'left');
          }
        }
        return;
      }
      case 'wakeup': {
        // Only the wakeup the hail now waits for acts; one a later event replaced does nothing.
        const h = hails.get(event.hailId);
        if (h?.wake?.at !== event.at || h.wake.purpose !== event.purpose) return;
        h.wake = undefined;
        if (event.purpose === 'dwell') eligible(h, now);
        else consider(h, now, event.purpose);
        return;
      }
      case 'tick': {
        for (const r of event.reports) {
          const shape = timetable.shapes.get(tripOf(r)?.shapeId ?? '');
          const known = runs.get(run(r));
          // An unknown trip, a shape with no line to measure along, and a fix no newer than the run's latest are ignored.
          if (!shape || shape.length < 2 || !(r.at > (known?.latest.at ?? -Infinity))) continue;
          // Each fix is matched on from the one before it; a run's first, over the whole shape (ADR-022 decision 5).
          runs.set(run(r), known
            ? { previous: known.latest, previousAlongM: known.latestAlongM, latest: r, latestAlongM: predict(shape, shape[0], known.latest, r, r.at, known.latestAlongM).alongM }
            : { latest: r, latestAlongM: predict(shape, shape[0], { ...r, at: r.at - 1 }, r, r.at).alongM });
        }
        for (const h of hails.values()) if (h.state === 'eligible') consider(h, now);
        return;
      }
    }
  };
}
