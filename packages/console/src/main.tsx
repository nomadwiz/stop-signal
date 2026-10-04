// Mounts the console and subscribes it to the hail service's signal stream with the browser's EventSource.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Signal } from '../../hail-core/src/signal.ts';
import { acknowledge, SignalList, subscribe } from './signals.tsx';

function Console() {
  const [signals, setSignals] = useState<Signal[]>([]);
  useEffect(() => {
    const source = new EventSource('/signals');
    subscribe(source, setSignals);
    return () => source.close();
  }, []);
  return <SignalList signals={signals} onAck={(signalId) => void acknowledge(signalId)} />;
}

createRoot(document.getElementById('root')!).render(<Console />);
