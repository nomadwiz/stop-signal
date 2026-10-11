// NotificationPort: C9 returns each hail's outcome to the passenger's device (FR11; ADR-012, ADR-032 decision 3).
// #61: an acknowledgement of the hail's signal is confirmed, its deadline with none is unacknowledged, and every
// abandonment is cannot hail.
export interface Outcome {
  stop: string;
  route: string;
  outcome: 'confirmed' | 'unacknowledged' | 'cannot-hail';
  // Cannot hail only: the abandoned record's reason, so OutcomeCard can word it (ADR-038's open item; ADR-017).
  reason?: 'stale' | 'deadline' | 'feed';
  // Deadline only: the predicted distance along the shape to the stop, in metres, of the route's next calling bus, as
  // Signal's distanceM; null when the feed shows none.
  nextDistanceM?: number | null;
}

// #158: the hail's Armed state, which ArmedStatus shows until the outcome (ADR-032, annotated 11-10-2026; ADR-038).
// Sent only when it changes; a hail starts waiting. It is no decision, so no record carries it.
export interface Status {
  stop: string;
  route: string;
  status: 'waiting' | 'sent' | 'moved' | 'stale';
}

// Synchronous, because the decision loop awaits nothing but its queue (ADR-002 rule 2).
export interface NotificationPort {
  outcome(handle: string, outcome: Outcome): void;
  status(handle: string, status: Status): void;
}
