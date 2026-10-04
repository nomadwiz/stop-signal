// C8: the SignalPort adapter. Streams each signal and retraction to every connected console as a
// server-sent event (FR10, FR12; m1-revised.md §3.4), served by node:http alone (ADR-015 decision 1).
import type { ServerResponse } from 'node:http';
import type { Signal, SignalPort } from '../../hail-core/src/signal.ts';

export function driverChannel(): SignalPort & { stream(res: ServerResponse): void } {
  const consoles = new Set<ServerResponse>();
  // The signals not yet retracted, so a console that connects or reconnects late still shows them.
  const live = new Map<string, Signal>();
  const write = (res: ServerResponse, event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const send = (event: string, data: object) => consoles.forEach((res) => write(res, event, data));
  return {
    signal(signal) {
      live.set(signal.id, signal);
      send('signal', signal);
    },
    retract(signalId) {
      live.delete(signalId);
      send('retract', { id: signalId });
    },
    stream(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).flushHeaders();
      live.forEach((signal) => write(res, 'signal', signal));
      consoles.add(res);
      res.on('close', () => consoles.delete(res));
    },
  };
}
