// The NotificationPort adapter: each armed device holds an outcome stream open, and receives its own outcomes, and
// its hails' Armed states as a second event (#158), on it as server-sent events (ADR-032). The stream's loss is
// ADR-010's connection loss, so it reaches the loop.
// #168: each registration's last outcome is kept, an ended hail's included, and re-sent when the handle's stream opens,
// until the handle registers again at that stop, and `: replayed` follows them (ADR-032, annotated 13-10-2026). A
// status is not kept.
import type { ServerResponse } from 'node:http';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { NotificationPort, Outcome } from '../../hail-core/src/notification.ts';

// ponytail: nothing caps the streams a handle, or the service, holds open, nor the outcomes it keeps, one per handle,
// stop and route ever hailed until a restart; add caps with #50 if one is needed.
export function passengerChannel(submit: (event: HailEvent) => void): NotificationPort & {
  stream(handle: string, res: ServerResponse): void;
  registered(handle: string, stop: string): void;
} {
  const streams = new Map<string, Set<ServerResponse>>();
  const kept = new Map<string, Map<string, Outcome>>();
  const send = (res: ServerResponse, event: 'outcome' | 'status', data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return {
    outcome(handle, outcome) {
      const last = kept.get(handle) ?? new Map<string, Outcome>();
      kept.set(handle, last.set(JSON.stringify([outcome.stop, outcome.route]), outcome));
      for (const res of streams.get(handle) ?? []) send(res, 'outcome', outcome);
    },
    registered(handle, stop) {
      const last = kept.get(handle) ?? new Map<string, Outcome>();
      for (const [key, outcome] of last) if (outcome.stop === stop) last.delete(key);
    },
    status(handle, status) {
      for (const res of streams.get(handle) ?? []) send(res, 'status', status);
    },
    stream(handle, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).flushHeaders();
      const open = streams.get(handle) ?? new Set<ServerResponse>();
      streams.set(handle, open.add(res));
      for (const outcome of kept.get(handle)?.values() ?? []) send(res, 'outcome', outcome);
      // A comment line every SSE client skips: the replay has ended, so the device may register again (the owner's
      // decision 41 of 13-10-2026). It is sent with nothing to replay too, so silence never stands for an empty replay.
      res.write(': replayed\n\n');
      // ADR-032, annotated 05-10-2026: only the last open stream's close submits connection-lost. A device that
      // reconnects can hold a new stream before its old one's close arrives, and that passenger is still connected.
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
