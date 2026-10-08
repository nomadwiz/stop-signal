// SignalPort: C4 hands C8 each signal, each change to it, and each retraction for the driver channel (FR10, FR12; ADR-012).
// From Figure 5.2's SIGNAL(vehicle, stop): one per vehicle run and stop, collapsing every hail committed on it (S4, #35;
// FR8). A hail that joins it changes it, and C4 hands it over again under the same id.
export interface Signal {
  id: string;
  vehicleId: string;
  stopId: string;
  // The earliest deadline of the hails it collapses, in epoch ms (product.md §4 step 6); null once one commits on a
  // stopped vehicle, which is due at once (ADR-037's [DECIDED:05-10-2026]).
  deadline: number | null;
  // How many hails it collapses: HailCard's waiting count.
  waiting: number;
}

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface SignalPort {
  signal(signal: Signal): void;
  retract(signalId: string): void;
}
