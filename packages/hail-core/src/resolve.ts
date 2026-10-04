// C3: which approaching vehicles will call at a stop (#22, FR5, QR2, doc/design/product.md §4 step 3).
// The match is on the vehicle's trip, never its route: two vehicles on one road are told apart by tripId.

// A live vehicle record as C7 hands it in. It has no route field: AT says the vehicle identifier
// "should not be used to deduce routes", so route identity is reached only through the trip.
export interface VehicleReport {
  vehicleId: string;
  // Absent when neither the record nor a trip update names the trip (ADR-019).
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

// predictedArrival is epoch ms, supplied by the caller from S2's prediction (#26). It is null when that
// prediction puts the vehicle past the stop: distance along the trip's shape ≤ 0 (ADR-026).
export interface Candidate {
  report: VehicleReport;
  predictedArrival: number | null;
}

// The candidates not yet past the stop whose run calls at it, soonest first; a tie keeps input order.
// The run is the trip in the map the report's start date names, and no other (ADR-025). Both runs of a
// shared trip_id have the same stop times (ADR-021 decision 1), so tripsAtStop answers for either.
export function callingAt(timetable: Timetable, stopId: string, candidates: readonly Candidate[]): (Candidate & { predictedArrival: number })[] {
  const { day, previousDay, trips, lateTrips } = timetable;
  const calling = new Set(timetable.tripsAtStop.get(stopId));
  const runs = ({ tripId, startDate }: VehicleReport) =>
    tripId !== undefined &&
    calling.has(tripId) &&
    ((startDate === day && trips.has(tripId)) || (startDate === previousDay && lateTrips.has(tripId)));
  return candidates
    .filter((c): c is Candidate & { predictedArrival: number } => c.predictedArrival !== null && runs(c.report))
    .sort((a, b) => a.predictedArrival - b.predictedArrival);
}
