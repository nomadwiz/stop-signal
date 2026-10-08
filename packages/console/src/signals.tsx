// The stand-in driver console's view (S8; ADR-015 decision 2): the live signals, each with an acknowledge button.
// URLs are relative, so the page works wherever the hail service serves it from (#50).
import type { Signal } from '../../hail-core/src/signal.ts';

// Applies #44's stream to the signals on screen: `signal` adds one, or replaces the one with its id when a hail joins it
// (#35), and `retract` removes the one it names.
// `source` is the page's EventSource, or any EventTarget dispatching MessageEvents, as the tests do.
export function subscribe(source: EventTarget, update: (change: (shown: Signal[]) => Signal[]) => void): void {
  const data = (event: Event) => JSON.parse((event as MessageEvent<string>).data);
  source.addEventListener('signal', (event) => {
    const signal: Signal = data(event);
    update((shown) => (shown.some((s) => s.id === signal.id) ? shown.map((s) => (s.id === signal.id ? signal : s)) : [...shown, signal]));
  });
  source.addEventListener('retract', (event) => {
    const { id }: { id: string } = data(event);
    update((shown) => shown.filter((signal) => signal.id !== id));
  });
}

export function acknowledge(signalId: string): Promise<Response> {
  return fetch('/ack', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signalId }) });
}

export function SignalList({ signals, onAck }: { signals: Signal[]; onAck: (signalId: string) => void }) {
  if (signals.length === 0) return <p>No live signals.</p>;
  return (
    <ul>
      {signals.map((signal) => (
        <li key={signal.id}>
          Stop request: vehicle {signal.vehicleId} at stop {signal.stopId}, {signal.waiting} waiting{' '}
          <button type="button" onClick={() => onAck(signal.id)}>
            Acknowledge
          </button>
        </li>
      ))}
    </ul>
  );
}
