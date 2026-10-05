import { describe, expect, it } from 'vitest';
import type { Call, Observed } from './actual-calls.ts';
import type { StaticIndex } from './gtfs-static.ts';
import { scenarios } from './scenarios.ts';

const T = 1_790_000_000_000;
const STOP = 'S';
// Only the fields scenarios reads: the day, each trip's route, the route's type, and stop sequences 1 to 3, so 2 is no trip end.
const stopTimes = [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }];
const index = {
  day: '20261003',
  trips: new Map([
    ['a-1', { routeId: 'R-a', stopTimes }], ['a-2', { routeId: 'R-a', stopTimes }], ['a-3', { routeId: 'R-a', stopTimes }],
    ['b-1', { routeId: 'R-b', stopTimes }],
  ]),
  routes: new Map([['R-a', { type: 3 }], ['R-b', { type: 3 }]]),
} as unknown as StaticIndex;
const call = (tripId: string, vehicleId: string, seconds: number): Call => ({
  tripId, startDate: '20261003', vehicleId, stopId: STOP, stopSequence: 2, at: T + seconds * 1000,
});
const arrivalAt = (tripId: string, seconds: number): [string, Observed] => [`${tripId}|20261003|2`, { arrival: T + seconds * 1000 }];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('scenarios', () => {
  it('gives one passenger on a single arrival a register and presence-start 300 s before the call and a presence-end at it (ADR-035)', () => {
    const [s] = scenarios([call('a-1', 'V1', 1000)], new Map(), index, STOP, 17.4, 1);

    const handle = s.events[0].event.kind === 'register' ? s.events[0].event.handle : '';
    expect(handle).toMatch(UUID_V4);
    expect(s).toEqual({
      stopId: STOP, day: '20261003', dS: 17.4, n: 1, class: 'single', group: 'single-on-both',
      calls: [{ tripId: 'a-1', vehicleId: 'V1', routeId: 'R-a', stopSequence: 2, at: T + 1_000_000, atArrival: null, atArrivalClass: 'single' }],
      events: [
        { at: T + 700_000, event: { kind: 'register', handle, stopId: STOP, routeId: 'R-a', leadTimeS: 0 } },
        { at: T + 700_000, event: { kind: 'presence-start', handle, stopId: STOP } },
        { at: T + 1_000_000, event: { kind: 'presence-end', handle, stopId: STOP } },
      ],
    });
  });

  it('starts a passenger 1 s after the previous call on their route when that is later than 300 s before', () => {
    const result = scenarios([call('a-1', 'V1', 900), call('b-1', 'V2', 950), call('a-2', 'V3', 1000)], new Map(), index, STOP, 17.4, 1);

    expect(result.map((s) => s.events[0].at - T)).toEqual([600_000, 650_000, 901_000]);
  });

  it('gives a queued arrival N passengers per route, each group ending presence at its own route\'s first vehicle', () => {
    const [s] = scenarios([call('a-1', 'V1', 1000), call('b-1', 'V2', 1005), call('a-2', 'V3', 1010)], new Map(), index, STOP, 17.4, 5);

    expect(s.class).toBe('queued');
    const registers = s.events.flatMap((e) => (e.event.kind === 'register' ? [e.event] : []));
    expect(registers.map((r) => r.routeId)).toEqual([...Array(5).fill('R-a'), ...Array(5).fill('R-b')]);
    expect(new Set(registers.map((r) => r.handle)).size).toBe(10);
    const ends = s.events.filter((e) => e.event.kind === 'presence-end');
    expect(ends.map((e) => e.at - T)).toEqual([...Array(5).fill(1_000_000), ...Array(5).fill(1_005_000)]);
  });

  it('starts every route\'s passengers 300 s before the arrival\'s first call, in time order, a passenger\'s register before their presence-start', () => {
    const [s] = scenarios([call('a-1', 'V1', 1000), call('b-1', 'V2', 1005)], new Map(), index, STOP, 17.4, 1);

    expect(s.events.map((e) => [e.at - T, e.event.kind])).toEqual([
      [700_000, 'register'], [700_000, 'presence-start'], [700_000, 'register'], [700_000, 'presence-start'],
      [1_000_000, 'presence-end'], [1_005_000, 'presence-end'],
    ]);
  });

  it('marks an arrival disputed when AT\'s arrival time moves one of its calls into the other class', () => {
    // 10 s apart on the oracle, two singles at D = 5.8 s; AT's arrival puts the second 3 s after the first.
    const result = scenarios([call('a-1', 'V1', 1000), call('b-1', 'V2', 1010)], new Map([arrivalAt('b-1', 1003)]), index, STOP, 5.8, 1);

    expect(result.map((s) => [s.class, s.group, s.calls[0].atArrival === null ? null : s.calls[0].atArrival - T, s.calls[0].atArrivalClass])).toEqual([
      ['single', 'disputed', null, 'queued'],
      ['single', 'disputed', 1_003_000, 'queued'],
    ]);
  });

  it('marks an arrival queued on both when its calls stay queued with AT\'s arrival times', () => {
    const [s] = scenarios([call('a-1', 'V1', 1000), call('b-1', 'V2', 1005)], new Map([arrivalAt('a-1', 1001)]), index, STOP, 5.8, 1);

    expect(s.group).toBe('queued-on-both');
  });

  it('gives the same handles on every run, and different ones for another N', () => {
    const handles = (n: number) => scenarios([call('a-1', 'V1', 1000)], new Map(), index, STOP, 17.4, n)[0].events.map((e) => (e.event.kind === 'register' ? e.event.handle : ''));

    expect(handles(1)).toEqual(handles(1));
    expect(handles(5)[0]).not.toBe(handles(1)[0]);
  });

  it('leaves out calls at other stops and at a trip\'s first or last stop (ADR-027)', () => {
    const result = scenarios([{ ...call('a-1', 'V1', 1000), stopId: 'other' }, { ...call('a-2', 'V2', 1000), stopSequence: 3 }], new Map(), index, STOP, 17.4, 1);

    expect(result).toEqual([]);
  });
});
