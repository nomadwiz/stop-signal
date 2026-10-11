import { describe, expect, it } from 'vitest';
import type { ServiceDay } from '../../hail-core/src/coordinator.ts';
import { bytesPerApproach, cpuPerTick } from './resources.ts';

const T = 1_790_000_000_000;
const empty: ServiceDay = { day: '20261003', previousDay: '20261002', stops: new Map(), trips: new Map(), lateTrips: new Map(), tripsAtStop: new Map(), shapes: new Map() };

describe('cpuPerTick', () => {
  it('gives each tick that has a next one its processor time and the interval to that next tick', () => {
    const ticks = cpuPerTick(empty, [{ at: T, reports: [] }, { at: T + 20_000, reports: [] }, { at: T + 40_005, reports: [] }], []);
    expect(ticks.map((t) => t.intervalMs)).toEqual([20_000, 20_005]);
    expect(ticks.every((t) => t.cpuMs >= 0)).toBe(true);
  });
});

describe('bytesPerApproach', () => {
  it('counts every byte of each log, newlines included, over the distinct (vehicle, stop) approaches it commits on', () => {
    const reg = '{"seq":1,"at":0,"kind":"registered","hailId":"h1","vehicleId":null,"payload":{"stopId":"S"}}';
    const com = '{"seq":2,"at":1,"kind":"committed","hailId":"h1","vehicleId":"V1","payload":{}}';
    const again = '{"seq":3,"at":2,"kind":"committed","hailId":"h1","vehicleId":"V1","payload":{}}';
    const bytes = [reg, com, again, reg].reduce((n, l) => n + l.length + 1, 0);
    expect(bytesPerApproach([[reg, com, again], [reg]])).toEqual({ bytes, approaches: 1 });
  });
});
