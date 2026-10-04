// The events that cross the seam into the decision loop (ADR-031). Each carries only what QR8 lets leave the
// device, and no time: an event's time is the Clock's reading when it is applied (ADR-028 decision 1).
// #32, #41 and #61 add `tick` and `wakeup`.
export type HailEvent =
  | { kind: 'register'; handle: string; stopId: string; routeId: string; leadTimeS: number }
  | { kind: 'cancel'; handle: string; stopId: string; routeId: string }
  | { kind: 'presence-start'; handle: string; stopId: string }
  | { kind: 'presence-end'; handle: string; stopId: string }
  | { kind: 'connection-lost'; handle: string }
  | { kind: 'console-ack'; signalId: string };
