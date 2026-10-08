// C8: the SignalPort adapter. Streams each signal and retraction to every connected console as a
// server-sent event (FR10, FR12; m1-revised.md §3.4), served by node:http alone (ADR-015 decision 1).
import type { ServerResponse } from 'node:http';
import type { SignalPort } from '../../hail-core/src/signal.ts';
import type { StaticIndex } from './gtfs-static.ts';

// Each signal goes out with HailCard's route, stop code and stop name, looked up in the service day's static index
// (ADR-038, decided 09-10-2026); each retraction with its reason, which the console words.
// ponytail: a console sees only what is sent while it is connected, so one that reconnects misses the gap.
// A snapshot on connect needs a signal lifecycle that ends a signal not retracted, which no document defines yet.
// ponytail: an id the index does not hold falls back to the id itself and an empty code; the coordinator signals only
// the index's own routes and stops, so this guards a mismatched index, not a live case.
export function driverChannel({ routes, stops }: Pick<StaticIndex, 'routes' | 'stops'>): SignalPort & { stream(res: ServerResponse): void } {
  const consoles = new Set<ServerResponse>();
  const send = (event: string, data: object) => {
    for (const res of consoles) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  return {
    signal: (signal) => {
      const stop = stops.get(signal.stopId);
      send('signal', { ...signal, route: routes.get(signal.routeId)?.shortName ?? signal.routeId, stopCode: stop?.code ?? '', stopName: stop?.name ?? signal.stopId });
    },
    retract: (signalId, reason) => send('retract', { id: signalId, reason }),
    stream(res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).flushHeaders();
      consoles.add(res);
      res.on('close', () => consoles.delete(res));
    },
  };
}
