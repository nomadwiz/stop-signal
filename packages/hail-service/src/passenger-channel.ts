// The NotificationPort adapter: each armed device holds an outcome stream open, and receives its own outcomes
// on it as server-sent events (ADR-032). The stream's loss is ADR-010's connection loss, so it reaches the loop.
import type { ServerResponse } from 'node:http';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { NotificationPort } from '../../hail-core/src/notification.ts';

export function passengerChannel(submit: (event: HailEvent) => void): NotificationPort & { stream(handle: string, res: ServerResponse): void } {
  // A device that reconnects can hold a second stream before the first one's close arrives, so a handle maps to
  // every stream it has open, and the connection is lost only when the last one closes.
  const streams = new Map<string, Set<ServerResponse>>();
  return {
    outcome(handle, outcome) {
      for (const res of streams.get(handle) ?? []) res.write(`event: outcome\ndata: ${JSON.stringify(outcome)}\n\n`);
    },
    stream(handle, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).flushHeaders();
      const open = streams.get(handle) ?? new Set<ServerResponse>();
      streams.set(handle, open.add(res));
      res.on('close', () => {
        open.delete(res);
        if (open.size > 0) return;
        streams.delete(handle);
        // A throw here would escape an event listener and end the process. The event is lost with it, as a throw in
        // submit loses it on any route, and the error is reported where the host's journal keeps it.
        try {
          submit({ kind: 'connection-lost', handle });
        } catch (error) {
          console.error('connection-lost could not be applied', error);
        }
      });
    },
  };
}
