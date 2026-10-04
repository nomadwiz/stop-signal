import { describe, expect, it } from 'vitest';
import { callingAt, type Timetable, type VehicleReport } from './resolve.ts';

const DAY = '20261007';
const PREVIOUS = '20261006';

// Route 70 runs all-stops trips A1 and A2 through stop S, express trip X past it, and B the other way.
// LATE is the previous day's trip past midnight; SHARED runs on both days under one trip_id (ADR-021).
const timetable: Timetable = {
  day: DAY,
  previousDay: PREVIOUS,
  trips: new Map([['A1', {}], ['A2', {}], ['X', {}], ['B', {}], ['SHARED', {}]]),
  lateTrips: new Map([['LATE', {}], ['SHARED', {}]]),
  tripsAtStop: new Map([
    ['S', ['A1', 'A2', 'LATE', 'SHARED']],
    ['T', ['A1', 'A2', 'X', 'B']],
  ]),
};

describe('callingAt', () => {
  it('excludes an express trip that skips the stop', () => {
    const express = { report: { vehicleId: 'v1', tripId: 'X', startDate: DAY }, predictedArrival: 1_000 };
    const allStops = { report: { vehicleId: 'v2', tripId: 'A1', startDate: DAY }, predictedArrival: 2_000 };

    expect(callingAt(timetable, 'S', [express, allStops])).toEqual([allStops]);
  });

  it('separates two vehicles on one route by tripId, ordered by predicted arrival', () => {
    const later = { report: { vehicleId: 'v1', tripId: 'A2', startDate: DAY }, predictedArrival: 90_000 };
    const otherWay = { report: { vehicleId: 'v2', tripId: 'B', startDate: DAY }, predictedArrival: 10_000 };
    const sooner = { report: { vehicleId: 'v3', tripId: 'A1', startDate: DAY }, predictedArrival: 30_000 };

    expect(callingAt(timetable, 'S', [later, otherWay, sooner])).toEqual([sooner, later]);
  });

  it('excludes a vehicle predicted past the stop, which arrives as null (ADR-026)', () => {
    const past = { report: { vehicleId: 'v1', tripId: 'A1', startDate: DAY }, predictedArrival: null };
    const coming = { report: { vehicleId: 'v2', tripId: 'A2', startDate: DAY }, predictedArrival: 5_000 };

    expect(callingAt(timetable, 'S', [past, coming])).toEqual([coming]);
  });

  it("takes a start date of the day from the day's own trips (ADR-025)", () => {
    const own = { report: { vehicleId: 'v1', tripId: 'A1', startDate: DAY }, predictedArrival: 1_000 };
    const notLate = { report: { vehicleId: 'v2', tripId: 'A1', startDate: PREVIOUS }, predictedArrival: 2_000 };

    expect(callingAt(timetable, 'S', [own, notLate])).toEqual([own]);
  });

  it("takes a start date of the previous day from the previous day's late trips (ADR-025)", () => {
    const late = { report: { vehicleId: 'v1', tripId: 'LATE', startDate: PREVIOUS }, predictedArrival: 1_000 };
    const notToday = { report: { vehicleId: 'v2', tripId: 'LATE', startDate: DAY }, predictedArrival: 2_000 };

    expect(callingAt(timetable, 'S', [late, notToday])).toEqual([late]);
  });

  it('chooses the run of a trip_id in both maps by its start date, and excludes any other date (ADR-025)', () => {
    const today = { report: { vehicleId: 'v1', tripId: 'SHARED', startDate: DAY }, predictedArrival: 1_000 };
    const lastNight = { report: { vehicleId: 'v2', tripId: 'SHARED', startDate: PREVIOUS }, predictedArrival: 2_000 };
    const older = { report: { vehicleId: 'v3', tripId: 'SHARED', startDate: '20261005' }, predictedArrival: 3_000 };

    expect(callingAt(timetable, 'S', [today, lastNight, older])).toEqual([today, lastNight]);
  });

  it('excludes a vehicle with no start date (ADR-025)', () => {
    const undated = { report: { vehicleId: 'v1', tripId: 'A1' }, predictedArrival: 1_000 };

    expect(callingAt(timetable, 'S', [undated])).toEqual([]);
  });

  it('excludes a vehicle with no tripId, since nothing else names its trip (ADR-019)', () => {
    const untagged = { report: { vehicleId: 'v1', startDate: DAY }, predictedArrival: 1_000 };

    expect(callingAt(timetable, 'S', [untagged])).toEqual([]);
  });

  it('returns nothing at a stop no trip calls at', () => {
    expect(callingAt(timetable, 'nowhere', [{ report: { vehicleId: 'v1', tripId: 'A1', startDate: DAY }, predictedArrival: 0 }])).toEqual([]);
  });

  it('gives VehicleReport no route field, so no route is read from the vehicle (m1-revised.md §4.4)', () => {
    // @ts-expect-error routeId is not a VehicleReport field.
    const report: VehicleReport = { vehicleId: 'v1', tripId: 'A1', routeId: '70' };
    expect(report.vehicleId).toBe('v1');
  });
});
