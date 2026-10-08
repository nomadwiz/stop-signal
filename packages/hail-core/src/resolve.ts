// C3: which approaching vehicles will call at a stop (#22, FR5, QR2, doc/design/product.md §4 step 3).
// The match is on the vehicle's trip, never its route: two vehicles on one road are told apart by tripId.

import type { Fix } from './predict.ts';

// Calibration value: how close a vehicle's path must come to a stop to count as calling there (ADR-018 decision 5).
// The oracle's radius, and the margin ADR-037's stopped-vehicle rule adds to the previous stop's distance.
export const CALL_RADIUS_M = 50;

// A live vehicle record as C7 hands it in. It has no route field: AT says the vehicle identifier
// "should not be used to deduce routes", so route identity is reached only through the trip.
// As a Fix it carries the position and the instant the vehicle measured it, under Fix's names, which predict reads (ADR-029).
export interface VehicleReport extends Fix {
  vehicleId: string;
  // C7 always sets it: it drops a record whose trip neither the record nor one started trip update names
  // (ADR-019, ADR-024). callingAt still turns away a report without one.
  tripId?: string;
  // The trip descriptor's start_date, YYYYMMDD: which day's run of the trip this is (ADR-025).
  startDate?: string;
}

// The part of C7's timetable index this needs. trips are day's own, lateTrips are previousDay's trips
// that run past midnight (ADR-021); tripsAtStop lists both. hail-service's StaticIndex satisfies it.
export interface Timetable {
  day: string;
  previousDay: string;
  trips: ReadonlyMap<string, unknown>;
  lateTrips: ReadonlyMap<string, unknown>;
  tripsAtStop: ReadonlyMap<string, readonly string[]>;
}

// distanceM is metres along the trip's shape to the stop, supplied by the caller from S2's prediction (ADR-022).
// It is null when that prediction puts the vehicle past the stop: distance ≤ 0 (ADR-026).
export interface Candidate {
  report: VehicleReport;
  distanceM: number | null;
}

// The candidates not yet past the stop whose run calls at it, nearest along the shape first; a tie keeps input order.
// Distance, not arrival time: a bus at speed 0 at a red light or an earlier stop keeps its place in line (ADR-036).
// The run is the trip in the map the report's start date names, and no other (ADR-025). Both runs of a
// shared trip_id have the same stop times (ADR-021 decision 1), so tripsAtStop answers for either.
export function callingAt(timetable: Timetable, stopId: string, candidates: readonly Candidate[]): (Candidate & { distanceM: number })[] {
  const { day, previousDay, trips, lateTrips } = timetable;
  const calling = new Set(timetable.tripsAtStop.get(stopId));
  const runs = ({ tripId, startDate }: VehicleReport) =>
    tripId !== undefined &&
    calling.has(tripId) &&
    ((startDate === day && trips.has(tripId)) || (startDate === previousDay && lateTrips.has(tripId)));
  return candidates
    .filter((c): c is Candidate & { distanceM: number } => c.distanceM !== null && runs(c.report))
    .sort((a, b) => a.distanceM - b.distanceM);
}
