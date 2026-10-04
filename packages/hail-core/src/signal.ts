// SignalPort: C4 hands C8 each signal and each retraction for the driver channel (FR10, FR12; ADR-012).
// Minimal shapes for #44, from Figure 5.2's SIGNAL(vehicle, stop): S4 (#35) builds the Signal and owns its fields.
export interface Signal {
  id: string;
  vehicleId: string;
  stopId: string;
}

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface SignalPort {
  signal(signal: Signal): void;
  retract(signalId: string): void;
}
