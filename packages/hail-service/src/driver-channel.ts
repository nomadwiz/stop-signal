// C8: the SignalPort adapter. Streams each signal and retraction to every connected console as a
// server-sent event (FR10, FR12; m1-revised.md §3.4), served by node:http alone (ADR-015 decision 1).
import type { ServerResponse } from 'node:http';
import type { SignalPort } from '../../hail-core/src/signal.ts';

// ponytail: a console sees only what is sent while it is connected, so one that reconnects misses the gap.
// A snapshot on connect needs a signal lifecycle that ends a signal not retracted, which no document defines yet.
export function driverChannel(): SignalPort & { stream(res: ServerResponse): void } {
  const consoles = new Set<ServerResponse>();
  const send = (event: string, data: object) => {
    for (const res of consoles) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    signal: (signal) => send('signal', signal),
    retract: (signalId) => send('retract', { id: signalId }),
    stream(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).flushHeaders();
      consoles.add(res);
      res.on('close', () => consoles.delete(res));
    },
  };
}
