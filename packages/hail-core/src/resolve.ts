// C3: which approaching vehicles will call at a stop (#22, FR5, QR2, doc/design/product.md §4 step 3).
// The match is on the vehicle's trip, never its route: two vehicles on one road are told apart by tripId.

// A live vehicle record as C7 hands it in. It has no route field: AT says the vehicle identifier
// "should not be used to deduce routes", so route identity is reached only through the trip.
export interface VehicleReport {
  vehicleId: string;
  // Absent when neither the record nor a trip update names the trip (ADR-019).
  tripId?: string;
}

// The part of C7's timetable index this needs: each stop's trip_ids, the day's own and the previous
// day's late trips alike. hail-service's StaticIndex satisfies it.
export interface Timetable {
  tripsAtStop: ReadonlyMap<string, readonly string[]>;
}

// predictedArrival is epoch ms, supplied by the caller: prediction is S2's (#26), not this function's.
export interface Candidate {
  report: VehicleReport;
  predictedArrival: number;
}

// The candidates whose trip calls at stopId, soonest first; a tie keeps input order.
// ponytail: "calls at" means anywhere on the trip. Excluding a vehicle already past the stop, and choosing
// between the day's run and the previous day's of a shared trip_id (ADR-021 decision 3), wait on the owner (#22).
export function callingAt(timetable: Timetable, stopId: string, candidates: readonly Candidate[]): Candidate[] {
  const trips = new Set(timetable.tripsAtStop.get(stopId));
  return candidates
    .filter(({ report }) => report.tripId !== undefined && trips.has(report.tripId))
    .sort((a, b) => a.predictedArrival - b.predictedArrival);
}
