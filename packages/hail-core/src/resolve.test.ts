import { describe, expect, it } from 'vitest';
import { callingAt, type Timetable, type VehicleReport } from './resolve.ts';

// Route 70 runs all-stops trips A1 and A2 through stop S, express trip X past it, and B the other way.
const timetable: Timetable = {
  tripsAtStop: new Map([
    ['S', ['A1', 'A2']],
    ['T', ['A1', 'A2', 'X', 'B']],
  ]),
};

describe('callingAt', () => {
  it('excludes an express trip that skips the stop', () => {
    const express = { report: { vehicleId: 'v1', tripId: 'X' }, predictedArrival: 1_000 };
    const allStops = { report: { vehicleId: 'v2', tripId: 'A1' }, predictedArrival: 2_000 };

    expect(callingAt(timetable, 'S', [express, allStops])).toEqual([allStops]);
  });

  it('separates two vehicles on one route by tripId, ordered by predicted arrival', () => {
    const later = { report: { vehicleId: 'v1', tripId: 'A2' }, predictedArrival: 90_000 };
    const otherWay = { report: { vehicleId: 'v2', tripId: 'B' }, predictedArrival: 10_000 };
    const sooner = { report: { vehicleId: 'v3', tripId: 'A1' }, predictedArrival: 30_000 };

    expect(callingAt(timetable, 'S', [later, otherWay, sooner])).toEqual([sooner, later]);
  });

  it('excludes a vehicle with no tripId, since nothing else names its trip (ADR-019)', () => {
    const untagged = { report: { vehicleId: 'v1' }, predictedArrival: 1_000 };

    expect(callingAt(timetable, 'S', [untagged])).toEqual([]);
  });

  it('returns nothing at a stop no trip calls at', () => {
    expect(callingAt(timetable, 'nowhere', [{ report: { vehicleId: 'v1', tripId: 'A1' }, predictedArrival: 0 }])).toEqual([]);
  });

  it('gives VehicleReport no route field, so no route is read from the vehicle (m1-revised.md §4.4)', () => {
    // @ts-expect-error routeId is not a VehicleReport field.
    const report: VehicleReport = { vehicleId: 'v1', tripId: 'A1', routeId: '70' };
    expect(report.vehicleId).toBe('v1');
  });
});
