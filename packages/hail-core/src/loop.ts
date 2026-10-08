// C2: the single-threaded decision loop over one totally ordered queue (ADR-002, FR15, QR9).
// Same events in, same order applied, so a replay reproduces the decision log.
import type { Clock } from './clock.ts';

// Returns enqueue. Each event gets the next sequence number, from 1, and is applied in that order.
// An event enqueued while another is being applied waits its turn instead of running inside it.
// Several events enqueued in one call are all queued before the first is applied.
export function eventLoop<E>(apply: (event: E, seq: number) => void): (...events: E[]) => void {
  const queue: E[] = [];
  let seq = 0;
  let applying = false;
  return (...events) => {
    queue.push(...events);
    if (applying) return;
    applying = true;
    // A throw reaches whoever enqueued; the finally keeps the loop alive for the events after it.
    // ponytail: those events wait for the next enqueue; drain them at once if the service ever runs on after a throw.
    try {
      while (queue.length > 0) apply(queue.shift()!, ++seq);
    } finally {
      applying = false;
    }
  };
}

// The deadline scheduler never sleeps (ADR-002): it holds wakeups, and wake() enqueues every one
// the Clock has reached, earliest first, equal times in the order they were set (sort is stable).
// submit() is how an arriving event enters the loop (ADR-028 decision 1): every wakeup due by then goes
// first, so queue order never contradicts clock order, and a wakeup at t beats an event arriving at t.
export function scheduler<E>(clock: Clock, enqueue: (...events: E[]) => void) {
  let pending: { at: number; event: E }[] = [];
  // A closure, not a method, so submit and wake still work when an adapter passes them on detached.
  const wake = (): void => {
    const now = clock.now();
    const due = pending.filter((w) => w.at <= now).sort((a, b) => a.at - b.at);
    pending = pending.filter((w) => w.at > now);
    // One call, so a throw while applying one due wakeup cannot drop the ones after it.
    enqueue(...due.map((w) => w.event));
  };
  return {
    at(at: number, event: E): void {
      // NaN fails both `<= now` and `> now`, so wake() would drop it without a trace.
      if (Number.isNaN(at)) throw new RangeError('a wakeup needs a time the Clock can reach');
      pending.push({ at, event });
    },
    wake,
    // When the earliest wakeup still held is due, Infinity when none is: replay sets the clock to it and wakes, so each
    // wakeup fires at its own t, as the live timer fires it within WAKE_INTERVAL_MS (ADR-002, ADR-028 decision 1).
    next: (): number => Math.min(...pending.map((w) => w.at)),
    // ponytail: ADR-028's form. A due wakeup that throws stops submit before the event is enqueued; the throw
    // reaches the caller, and the event is gone. Enqueue both in one call if a caller ever needs the event kept.
    submit(event: E): void {
      wake();
      enqueue(event);
    },
  };
}
