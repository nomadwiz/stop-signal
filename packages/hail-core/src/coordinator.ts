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

// A live hail. A terminal transition deletes it. The handle is a credential (ADR-032 decision 5), so no record carries
// it: records name the hail by id.
interface Hail {
  id: string;
  handle: string;
  stopId: string;
  routeId: string;
}

export function hailCoordinator({ record }: {
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

  const note = (h: Hail, kind: string, payload: { [key: string]: Json } = {}, vehicleId: string | null = null) =>
    record({ kind, hailId: h.id, vehicleId, payload });
  const end = (h: Hail, kind: string) => {
    note(h, kind);
    hails.delete(h.id);
  };
  const registration = ({ handle, stopId, routeId }: { handle: string; stopId: string; routeId: string }) =>
    [...hails.values()].find((h) => h.handle === handle && h.stopId === stopId && h.routeId === routeId);

  return (event) => {
    switch (event.kind) {
      case 'register': {
        if (registration(event)) return;
        const { handle, stopId, routeId, leadTimeS } = event;
        const h: Hail = { id: `h${++hailCount}`, handle, stopId, routeId };
        hails.set(h.id, h);
        note(h, 'registered', { stopId, routeId, leadTimeS });
        return;
      }
      case 'cancel': {
        // Only a cancel withdraws a hail (ADR-010 decision 2, ADR-040).
        const h = registration(event);
        if (h) end(h, 'withdrawn');
        return;
      }
    }
  };
}
