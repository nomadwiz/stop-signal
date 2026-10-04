// Mounts the console and subscribes it to the hail service's signal stream with the browser's EventSource.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Signal } from '../../hail-core/src/signal.ts';
import { acknowledge, onStreamEvent, SignalList } from './signals.tsx';

function Console() {
  const [signals, setSignals] = useState<Signal[]>([]);
  useEffect(() => {
    const source = new EventSource('/signals');
    for (const event of ['signal', 'retract'] as const) {
      source.addEventListener(event, (message) => setSignals((shown) => onStreamEvent(shown, event, JSON.parse(message.data))));
    }
    return () => source.close();
  }, []);
  return <SignalList signals={signals} onAck={(signalId) => void acknowledge(signalId)} />;
}

createRoot(document.getElementById('root')!).render(<Console />);
