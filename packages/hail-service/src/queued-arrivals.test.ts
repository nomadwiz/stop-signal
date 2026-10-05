import { describe, expect, it, vi } from 'vitest';
import type { Call } from './actual-calls.ts';
import type { StaticIndex } from './gtfs-static.ts';
import { arrivals, rank, windowsArg } from './queued-arrivals.ts';

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

  it('counts calls with no vehicle id on different trips as different vehicles', () => {
    const result = arrivals([call('A', '', 0, 'trip-1'), call('A', '', 3, 'trip-2')], 5_800);

    expect(result.map(shape)).toEqual([{ stopId: 'A', at: [0, 3], vehicles: 2 }]);
  });

  it('counts a vehicle calling twice within the window as one vehicle', () => {
    const result = arrivals([call('A', 'V1', 0, 'trip-1'), call('A', 'V1', 4, 'trip-2')], 5_800);

    expect(result.map(shape)).toEqual([{ stopId: 'A', at: [0, 4], vehicles: 1 }]);
  });
});

describe('rank', () => {
  // Only the fields rank reads: which route each trip runs, that route's type, and each trip's stop sequences 1 to 3.
  const stopTimes = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }];
  const index = {
    trips: new Map([['bus-1', { routeId: 'R-bus', stopTimes }], ['bus-2', { routeId: 'R-bus', stopTimes }], ['train-1', { routeId: 'R-train', stopTimes }]]),
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

  it('leaves out a call at its trip\'s first or last stop (ADR-027)', () => {
    const calls = [
      { ...call('A', 'V1', 0, 'bus-1'), stopSequence: 1 }, { ...call('A', 'V2', 2, 'bus-2'), stopSequence: 1 },
      { ...call('B', 'V1', 0, 'bus-1'), stopSequence: 3 }, call('B', 'V2', 2, 'bus-2'),
    ];

    expect(rank(calls, index, 5_800)).toEqual([{ stopId: 'B', queued: 0, single: 1 }]);
  });

  it('breaks a tie in queued arrivals by stop_id', () => {
    const calls = [call('Z', 'V1', 0, 'bus-1'), call('Z', 'V2', 1, 'bus-2'), call('M', 'V1', 50, 'bus-1'), call('M', 'V2', 51, 'bus-2')];

    expect(rank(calls, index, 5_800).map((r) => r.stopId)).toEqual(['M', 'Z']);
  });
});

describe('windowsArg', () => {
  it("returns a CLI's D windows in seconds", () => {
    expect(windowsArg('1790960530883', '1790983016489', '17.4,5.8')).toEqual([17.4, 5.8]);
  });

  it('exits when from-ms, to-ms or any D is not a positive number', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => windowsArg('1', '2', '17.4,x')).toThrow('exit');
    expect(() => windowsArg('0', '2', '17.4')).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    error.mockRestore();
  });
});
