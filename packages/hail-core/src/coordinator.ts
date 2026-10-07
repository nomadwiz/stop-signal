// C2: runs each hail through its lifecycle state machine, from register to commit (#32, FR7, FR13; Milestone 2's
// Figure 5.4). One function applies every event the loop hands it, in queue order (ADR-002), and writes exactly one
// decision record per transition (ADR-017).
import type { Clock } from './clock.ts';
import { signalDeadline } from './deadline.ts';
import type { HailEvent } from './events.ts';
import { FEED_INTERVAL_MS, predict, type Point } from './predict.ts';
import { CALL_RADIUS_M, callingAt, type Timetable, type VehicleReport } from './resolve.ts';
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
// it: records name the hail by id. left is set by a reported departure with nothing delivered (ADR-040), and unattended by
// a connection lost at the stop (ADR-010 decision 3). wake is the one wakeup the hail now waits for; any other wakeup for
// it is stale and does nothing.
interface Hail {
  id: string;
  handle: string;
  stopId: string;
  routeId: string;
  state: 'registered' | 'present' | 'eligible' | 'committed';
  left: boolean;
  unattended: boolean;
  // The vehicle runs this hail passed over for being too close to stop, never resolved to again (ADR-039 decision 2).
  skipped: Set<string>;
  // The run the hail last resolved to: its last pick, stale or fresh (ADR-039, annotated 08-10-2026).
  resolvedTo?: string;
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
  // ponytail: a committed hail whose passenger never reports leaving stays here until #61's outcomes end it; a hail
  // for an unknown stop or route stays until cancelled. Reject unknown stops at register if
  // that growth matters.
  const hails = new Map<string, Hail>();
  let hailCount = 0;
  // When each passenger arrived at each stop, keyed [handle, stop]: presence is the passenger's, not a hail's, so a hail
  // registered while they wait counts its dwell from their arrival (ADR-040, decided 07-10-2026). Only a presence-end
  // removes an entry, so a lost connection keeps it and a return starts a fresh dwell (ADR-040 decision 2).
  // ponytail: a presence-start for a handle with no hail is held until its presence-end, for the same reason.
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
    if (kind === 'returned') skip(h, now);
    if (now >= since + dwellMs) eligible(h, now);
    else wake(h, 'dwell', since + dwellMs);
  };
  const eligible = (h: Hail, now: number) => {
    h.state = 'eligible';
    note(h, 'eligible');
    skip(h, now);
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

  // The hail passes over each calling vehicle that is moving, fresh, and already inside its stopping distance, at
  // registration (ADR-039 decision 1), on a return (ADR-040, decided 07-10-2026) and on eligibility (ADR-039, annotated
  // 07-10-2026). At speed above 0, signalDeadline's null is exactly that test (ADR-023 decisions 3 and 4). A stopped
  // vehicle is the stopped-vehicle rule's (decision 4), and a stale one cannot be shown past its deadline (decision 5).
  // One record lists the runs newly skipped, and none is written when there are none.
  const skip = (h: Hail, now: number) => {
    const passed = calling(h, now).filter((c) =>
      c.speedMps > 0 && !c.stale && !signalDeadline(now, c.distanceM, c.speedMps, decelMps2) && !h.skipped.has(run(c.report)));
    for (const c of passed) h.skipped.add(run(c.report));
    if (passed.length) note(h, 'skipped', { candidates: passed.map((c) => c.report.vehicleId) });
  };

  // Metres along the report's trip shape from the trip's stop before stopId to stopId, plus CALL_RADIUS_M; -1 when stopId
  // is the trip's first stop, so no stopped vehicle on it is due (ADR-037's [DECIDED:05-10-2026]). m1.ts's reach.
  // ponytail: places that stop by predict at speed 0, nearest over the whole shape, as predict places stopId itself.
  const reach = (r: VehicleReport, stopId: string) => {
    const trip = tripOf(r)!;
    const i = trip.stopTimes.findIndex((st) => st.stopId === stopId);
    const previous = timetable.stops.get(trip.stopTimes[i - 1]?.stopId ?? '');
    if (!previous) return -1;
    const shape = timetable.shapes.get(trip.shapeId)!;
    return predict(shape, timetable.stops.get(stopId)!, { ...previous, at: 0 }, { ...previous, at: 1 }, 1).distanceM + CALL_RADIUS_M;
  };

  // An eligible hail commits on the nearest calling vehicle one feed interval before its deadline, or at once if that
  // instant has passed (ADR-037 decision 1, annotated 07-10-2026); until then it waits on a commit wakeup, which any
  // later report that moves the deadline replaces. Run on eligibility, on every tick, and on its own wakeups. The pick is
  // the nearest calling vehicle not skipped; every pick, stale or fresh, is what the hail has resolved to.
  const consider = (h: Hail, now: number, purpose?: Purpose) => {
    for (const p of calling(h, now)) {
      const key = run(p.report);
      if (h.skipped.has(key)) continue;
      const resolved = h.resolvedTo === key;
      h.resolvedTo = key;
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
      // At speed 0 no deadline follows; a stopped vehicle within reach is due at once, and one beyond waits for its next
      // report (ADR-037's [DECIDED:05-10-2026]).
      if (p.speedMps === 0) {
        if (p.distanceM <= reach(p.report, h.stopId)) commit(h, vehicleId, null);
        return;
      }
      // Inside its stopping distance: abandoned if the hail had resolved to it, not passed to the next bus (ADR-039
      // decision 3); skipped, as at registration, if this is the first time the hail picks it, and the next calling
      // vehicle considered in its place (ADR-039, annotated 08-10-2026).
      if (!d) {
        if (resolved) return end(h, 'abandoned', { reason: 'deadline' }, vehicleId);
        h.skipped.add(key);
        note(h, 'skipped', { candidates: [vehicleId] });
        continue;
      }
      if (now >= d.deadline - FEED_INTERVAL_MS) commit(h, vehicleId, d.deadline);
      else wake(h, 'commit', d.deadline - FEED_INTERVAL_MS);
      return;
    }
  };
  // One Signal per hail until S4 (#35) aggregates them. Committed is Delivered: re-resolving and retracting are #38's.
  const commit = (h: Hail, vehicleId: string, deadline: number | null) => {
    h.state = 'committed';
    h.wake = undefined;
    const signalId = `s${++signalCount}`;
    note(h, 'committed', { deadline, signalId }, vehicleId);
    signals.signal({ id: signalId, vehicleId, stopId: h.stopId });
  };

  // The live hails a presence event moves: every one of that passenger's at that stop.
  const atStop = (stop: { handle: string; stopId: string }) =>
    [...hails.values()].filter((h) => h.handle === stop.handle && h.stopId === stop.stopId);
  // The one live hail a register or cancel names, by handle, stop and route (ADR-032 decision 4).
  const registration = (e: { handle: string; stopId: string; routeId: string }) => atStop(e).find((h) => h.routeId === e.routeId);

  return (event) => {
    const now = clock.now();
    switch (event.kind) {
      case 'register': {
        if (registration(event)) return;
        const { handle, stopId, routeId, leadTimeS } = event;
        const h: Hail = { id: `h${++hailCount}`, handle, stopId, routeId, state: 'registered', left: false, unattended: false, skipped: new Set() };
        hails.set(h.id, h);
        note(h, 'registered', { stopId, routeId, leadTimeS });
        skip(h, now);
        const since = presence.get(here(h));
        if (since !== undefined) arrive(h, 'present', since, now);
        return;
      }
      case 'cancel': {
        // Only a cancel withdraws a hail (ADR-010 decision 2, ADR-040).
        // ponytail: a cancel after the commit leaves the signal on the console until #38 retracts it.
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
          // Back to Registered, uncommitted, until a return (ADR-040 decision 3). The departure is reported, so it also
          // ends Unattended. A delivered hail is spent (ADR-010 decision 1, FR13), Unattended or not: decision 4 keeps
          // silence from spending it, and this is no silence (ADR-010, annotated 08-10-2026).
          if (h.state === 'present' || h.state === 'eligible') {
            h.state = 'registered';
            h.left = true;
            h.unattended = false;
            h.wake = undefined;
            note(h, 'left');
          } else if (h.state === 'committed') end(h, 'spent');
        }
        return;
      }
      case 'connection-lost': {
        // At the stop, the hail carries on to its own deadline, marked Unattended (ADR-010 decision 3); away from it,
        // after a reported departure, it stays Registered and uncommitted (ADR-040 decision 5).
        for (const h of hails.values()) {
          if (h.handle !== event.handle || h.state === 'registered' || h.unattended) continue;
          h.unattended = true;
          note(h, 'unattended');
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
