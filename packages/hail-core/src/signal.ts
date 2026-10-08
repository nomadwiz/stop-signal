// SignalPort: C4 hands C8 each signal, each change to it, and each retraction for the driver channel (FR10, FR12; ADR-012).
// From Figure 5.2's SIGNAL(vehicle, stop): one per vehicle run and stop, collapsing every hail committed on it (S4, #35;
// FR8). A hail that joins it changes it, and C4 hands it over again under the same id.
// HailCard's fields the core alone knows travel on it; C8 adds the route's short name and the stop's code and name from
// the static index (ADR-038, decided 09-10-2026).
export interface Signal {
  id: string;
  vehicleId: string;
  tripId: string;
  routeId: string;
  stopId: string;
  // When it was first sent, in epoch ms: HailCard's time.
  at: number;
  // The predicted distance along the shape to the stop, in metres, at its latest commit or join.
  distanceM: number;
  // The earliest deadline of the hails it collapses, in epoch ms (product.md §4 step 6); null once one commits on a
  // stopped vehicle, which is due at once (ADR-037's [DECIDED:05-10-2026]).
  deadline: number | null;
  // How many hails it collapses: HailCard's waiting count.
  waiting: number;
}

// Why a signal is withdrawn, which the console words for WithdrawalAlert (ADR-038, decided 09-10-2026). C4 retracts a
// signal when its last hail is cancelled, leaves, or moves to another bus (#38).
export type WithdrawalReason = 'left' | 'cancelled' | 'moved';

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface SignalPort {
  signal(signal: Signal): void;
  retract(signalId: string, reason: WithdrawalReason): void;
}
