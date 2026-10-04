// The stand-in driver console's view (S8; ADR-015 decision 2): the live signals, each with an acknowledge button.
// URLs are relative, so the page works wherever the hail service serves it from (#50).
import type { Signal } from '../../hail-core/src/signal.ts';

// One stream event applied to the signals on screen: a signal is added, a retraction removes its signal.
export function onStreamEvent(shown: Signal[], event: 'signal' | 'retract', data: { id: string }): Signal[] {
  return event === 'signal' ? [...shown, data as Signal] : shown.filter((signal) => signal.id !== data.id);
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
          Stop request: vehicle {signal.vehicleId} at stop {signal.stopId}{' '}
          <button type="button" onClick={() => onAck(signal.id)}>
            Acknowledge
          </button>
        </li>
      ))}
    </ul>
  );
}
