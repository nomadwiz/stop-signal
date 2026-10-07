// C2: runs each hail through its lifecycle state machine, from register to commit (#32, FR7, FR13; Milestone 2's
// Figure 5.4). One function applies every event the loop hands it, in queue order (ADR-002), and writes exactly one
// decision record per transition (ADR-017).
import type { Clock } from './clock.ts';
import type { HailEvent } from './events.ts';
import type { Point } from './predict.ts';
import type { Timetable } from './resolve.ts';
import type { SignalPort } from './signal.ts';
import type { Json, recorder } from './trace.ts';

// The service day the coordinator resolves against. hail-service's StaticIndex satisfies it.
export interface ServiceDay extends Timetable {
  trips: ReadonlyMap<string, Trip>;
  lateTrips: ReadonlyMap<string, Trip>;
  stops: ReadonlyMap<string, Point>;
  shapes: ReadonlyMap<string, readonly Point[]>;
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
  state: 'registered' | 'present' | 'eligible';
  left: boolean;
  wake?: { at: number; purpose: Purpose };
}
type Purpose = Extract<HailEvent, { kind: 'wakeup' }>['purpose'];

export function hailCoordinator({ clock, record, schedule, dwellMs }: {
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

  const note = (h: Hail, kind: string, payload: { [key: string]: Json } = {}, vehicleId: string | null = null) =>
    record({ kind, hailId: h.id, vehicleId, payload });
  const end = (h: Hail, kind: string) => {
    note(h, kind);
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
    if (now >= since + dwellMs) eligible(h);
    else wake(h, 'dwell', since + dwellMs);
  };
  const eligible = (h: Hail) => {
    h.state = 'eligible';
    note(h, 'eligible');
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
        if (event.purpose === 'dwell') eligible(h);
        return;
      }
    }
  };
}
