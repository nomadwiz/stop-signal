import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { driverChannel } from './driver-channel.ts';

let server: Server;
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

// A console on a real socket: fetch resolves once the stream's headers arrive, so the adapter holds it by then.
async function serve(channel: ReturnType<typeof driverChannel>): Promise<string> {
  server = createServer((_req, res) => channel.stream(res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/signals`;
}

// Reads whole server-sent events off the stream until `count` have arrived.
async function events(response: Response, count: number): Promise<{ event: string; data: unknown }[]> {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  while (text.split('\n\n').length - 1 < count) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`the stream ended after ${text.split('\n\n').length - 1} of ${count} events`);
    text += value;
  }
  return text
    .split('\n\n')
    .slice(0, count)
    .map((block) => {
      const field = (name: string) => block.split('\n').find((line) => line.startsWith(`${name}: `))!.slice(name.length + 2);
      return { event: field('event'), data: JSON.parse(field('data')) };
    });
}

const signal = {
  id: 's1', vehicleId: 'v7', tripId: '1043-70', routeId: '70-202', stopId: '7177-4660a5ff', at: 1_790_000_000_000, distanceM: 450, deadline: 1_790_000_022_444, waiting: 2,
};
// The static index's route and stop, as gtfs-static.ts loads them.
const index = {
  routes: new Map([['70-202', { id: '70-202', shortName: '70', type: 3 }]]),
  stops: new Map([['7177-4660a5ff', { id: '7177-4660a5ff', code: '6543', name: 'Ti Rakau Dr / Pakuranga Rd', lat: -36.9, lon: 174.9 }]]),
};
// What the console receives: the signal, with HailCard's route, stop code and stop name looked up (ADR-038, decided 09-10-2026).
const shown = { ...signal, route: '70', stopCode: '6543', stopName: 'Ti Rakau Dr / Pakuranga Rd' };

describe('driverChannel', () => {
  it('streams a signal, with its route and stop looked up, and then its retraction with the reason, in that order', async () => {
    const channel = driverChannel(index);
    const response = await fetch(await serve(channel));

    channel.signal(signal);
    channel.retract('s1', 'left');

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await events(response, 2)).toEqual([
      { event: 'signal', data: shown },
      { event: 'retract', data: { id: 's1', reason: 'left' } },
    ]);
  });

  it('falls back to the ids for a route or stop the static index does not hold, and an empty stop code', async () => {
    const channel = driverChannel({ routes: new Map(), stops: new Map() });
    const response = await fetch(await serve(channel));

    channel.signal(signal);

    expect(await events(response, 1)).toEqual([{ event: 'signal', data: { ...signal, route: '70-202', stopCode: '', stopName: '7177-4660a5ff' } }]);
  });

  it('streams every event to each connected console', async () => {
    const channel = driverChannel(index);
    const url = await serve(channel);
    const [a, b] = await Promise.all([fetch(url), fetch(url)]);

    channel.signal(signal);

    expect(await events(a, 1)).toEqual([{ event: 'signal', data: shown }]);
    expect(await events(b, 1)).toEqual([{ event: 'signal', data: shown }]);
  });
});
