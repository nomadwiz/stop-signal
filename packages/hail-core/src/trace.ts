// C6: numbers every decision in order and stamps it from C11, then hands it to TraceSink (FR15, QR9).
// Storage is TraceSink's job; ADR-015 decision 4 makes the file adapter's log JSON Lines.
import type { Clock } from './clock.ts';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// hailId is null for a decision about a vehicle alone, vehicleId for one made before any vehicle is chosen.
export interface DecisionRecord {
  seq: number;
  at: number;
  kind: string;
  hailId: string | null;
  vehicleId: string | null;
  payload: { [key: string]: Json };
}

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface TraceSink {
  append(record: DecisionRecord): void;
}

export function recorder(clock: Clock, sink: TraceSink): (decision: Omit<DecisionRecord, 'seq' | 'at'>) => void {
  let seq = 0;
  return (decision) => sink.append({ seq: ++seq, at: clock.now(), ...decision });
}
