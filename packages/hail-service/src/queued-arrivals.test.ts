import { describe, expect, it } from 'vitest';
import type { Call } from './actual-calls.ts';
import type { StaticIndex } from './gtfs-static.ts';
import { arrivals, rank } from './queued-arrivals.ts';

const T = 1_790_000_000_000;
const call = (stopId: string, vehicleId: string, seconds: number, tripId = `trip-${vehicleId}`): Call => ({
  tripId, startDate: '20261003', vehicleId, stopId, stopSequence: 2, at: T + seconds * 1000,
});
const shape = (a: { stopId: string; calls: Call[]; vehicles: number }) => ({ stopId: a.stopId, at: a.calls.map((c) => (c.at - T) / 1000), vehicles: a.vehicles });

describe('arrivals', () => {
  it('groups two vehicles reaching one stop within the window into one arrival of two vehicles', () => {
    const result = arrivals([call('A', 'V1', 0), call('A', 'V2', 5), call('B', 'V3', 3)], 5_800);

    expect(result.map(shape)).toEqual([
      { stopId: 'A', at: [0, 5], vehicles: 2 },
      { stopId: 'B', at: [3], vehicles: 1 },
    ]);
  });

  it('includes a call exactly one window after the first, and opens a new arrival just past it', () => {
    const result = arrivals([call('A', 'V1', 0), call('A', 'V2', 10), call('A', 'V3', 10.001)], 10_000);

    expect(result.map(shape)).toEqual([
      { stopId: 'A', at: [0, 10], vehicles: 2 },
      { stopId: 'A', at: [10.001], vehicles: 1 },
    ]);
  });

  it('measures the window from the arrival\'s first call, not from the call before', () => {
    const result = arrivals([call('A', 'V3', 20), call('A', 'V1', 0), call('A', 'V2', 10)], 15_000);

    expect(result.map(shape)).toEqual([
      { stopId: 'A', at: [0, 10], vehicles: 2 },
      { stopId: 'A', at: [20], vehicles: 1 },
    ]);
  });

  it('counts a vehicle calling twice within the window as one vehicle', () => {
    const result = arrivals([call('A', 'V1', 0, 'trip-1'), call('A', 'V1', 4, 'trip-2')], 5_800);

    expect(result.map(shape)).toEqual([{ stopId: 'A', at: [0, 4], vehicles: 1 }]);
  });
});

describe('rank', () => {
  // Only the fields rank reads: which route each trip runs and that route's type.
  const index = {
    trips: new Map([['bus-1', { routeId: 'R-bus' }], ['bus-2', { routeId: 'R-bus' }], ['train-1', { routeId: 'R-train' }]]),
    routes: new Map([['R-bus', { type: 3 }], ['R-train', { type: 2 }]]),
  } as unknown as StaticIndex;

  it('counts queued and single arrivals per stop over bus calls only, most queued first', () => {
    const calls = [
      call('A', 'V1', 0, 'bus-1'), call('A', 'V2', 2, 'bus-2'), call('A', 'V1', 100, 'bus-1'),
      call('B', 'V1', 0, 'bus-1'), call('B', 'V9', 2, 'train-1'),
    ];

    expect(rank(calls, index, 5_800)).toEqual([
      { stopId: 'A', queued: 1, single: 1 },
      { stopId: 'B', queued: 0, single: 1 },
    ]);
  });

  it('breaks a tie in queued arrivals by stop_id', () => {
    const calls = [call('Z', 'V1', 0, 'bus-1'), call('Z', 'V2', 1, 'bus-2'), call('M', 'V1', 50, 'bus-1'), call('M', 'V2', 51, 'bus-2')];

    expect(rank(calls, index, 5_800).map((r) => r.stopId)).toEqual(['M', 'Z']);
  });
});
