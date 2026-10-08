import type { VehicleReport } from './resolve.ts';

// The events that cross the seam into the decision loop (ADR-031). Each carries only what QR8 lets leave the
// device, and no time: an event's time is the Clock's reading when it is applied (ADR-028 decision 1).
// #61 adds its own. A tick's reports each carry their own fix time; a wakeup carries the t it was scheduled for
// (ADR-028 decision 3). C5's feed wakeup names no hail (#41).
export type HailEvent =
  | { kind: 'register'; handle: string; stopId: string; routeId: string; leadTimeS: number }
  | { kind: 'cancel'; handle: string; stopId: string; routeId: string }
  | { kind: 'presence-start'; handle: string; stopId: string }
  | { kind: 'presence-end'; handle: string; stopId: string }
  | { kind: 'connection-lost'; handle: string }
  | { kind: 'console-ack'; signalId: string }
  | { kind: 'tick'; reports: VehicleReport[] }
  | { kind: 'wakeup'; at: number; hailId: string; purpose: 'dwell' | 'commit' | 'deadline' }
  | { kind: 'wakeup'; at: number; purpose: 'feed' };
