// NotificationPort: C9 returns each hail's outcome to the passenger's device (FR11; ADR-012, ADR-032 decision 3).
// What each outcome means, and when one is sent, is #61's.
export interface Outcome {
  stop: string;
  route: string;
  outcome: 'confirmed' | 'unacknowledged' | 'cannot-hail';
}

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface NotificationPort {
  outcome(handle: string, outcome: Outcome): void;
}
