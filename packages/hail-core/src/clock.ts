// C11: system time when live, trace timestamps on replay (ADR-002). Epoch milliseconds.
export interface Clock {
  now(): number;
}
