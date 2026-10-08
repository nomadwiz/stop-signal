import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import { driverChannel } from './driver-channel.ts';
import { passengerChannel } from './passenger-channel.ts';
import { hailServer } from './server.ts';

let server: Server;
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

// The real loop behind the server, so a test sees what the loop applies, not what the adapter meant to send.
// A test may pass its own submit instead.
async function serve(submit?: (event: HailEvent) => void) {
  const applied: HailEvent[] = [];
  const wakeups = scheduler<HailEvent>({ now: () => 0 }, eventLoop((event) => applied.push(event)));
  const channel = driverChannel({ routes: new Map(), stops: new Map() });
  const passengers = passengerChannel(submit ?? wakeups.submit);
  server = hailServer({ channel, passengers, submit: submit ?? wakeups.submit });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, applied, channel, passengers };
}

const post = (url: string, body: string, signal?: AbortSignal) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });

describe('hailServer, the driver console routes', () => {
  it('applies an acknowledgement in the loop as a console-ack event', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/ack`, JSON.stringify({ signalId: 's1' }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'console-ack', signalId: 's1' }]);
  });

  it.each([
    ['a key outside the allow-list', JSON.stringify({ signalId: 's1', lat: -36.86698 })],
    ['a missing signalId', JSON.stringify({})],
    ['a signalId that is not a string', JSON.stringify({ signalId: 7 })],
    ['an empty signalId', JSON.stringify({ signalId: '' })],
    ['a body that is not an object', JSON.stringify(['s1'])],
    ['a body that is not JSON', 'signalId=s1'],
  ])('refuses %s with 400, and the loop applies nothing', async (_case, body) => {
    const { base, applied } = await serve();

    const response = await post(`${base}/ack`, body);

    expect(response.status).toBe(400);
    expect(applied).toEqual([]);
  });

  it('refuses a body over 1 KiB with 413, and the loop applies nothing', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/ack`, JSON.stringify({ signalId: 's'.repeat(1024) }));

    expect(response.status).toBe(413);
    expect(applied).toEqual([]);
  });

  it('refuses with 413 a body still streaming once it passes 1 KiB, without waiting for its end', async () => {
    const { base, applied } = await serve();
    // A chunked body that passes 1 KiB and is never ended: the server must answer from what it has read.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/ack`, { method: 'POST' }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.write('x'.repeat(2048));
    });

    expect(status).toBe(413);
    expect(applied).toEqual([]);
  });

  // An async listener's rejection is unhandled, and an unhandled rejection ends a Node 22 process.
  it('keeps serving after a client aborts its body part-way', async () => {
    const { base, applied } = await serve();
    await new Promise<void>((resolve) => {
      const req = request(`${base}/ack`, { method: 'POST', headers: { 'content-length': '100' } });
      req.on('error', () => resolve());
      req.write('{"signalId":', () => setImmediate(() => req.destroy()));
    });

    const response = await post(`${base}/ack`, JSON.stringify({ signalId: 's1' }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'console-ack', signalId: 's1' }]);
  });

  it('answers 500 and keeps serving when applying an event throws', async () => {
    let fail = true;
    const { base } = await serve(() => {
      if (fail) throw new Error('apply failed');
    });

    expect((await post(`${base}/ack`, JSON.stringify({ signalId: 's1' }))).status).toBe(500);
    fail = false;
    expect((await post(`${base}/ack`, JSON.stringify({ signalId: 's1' }))).status).toBe(204);
  });

  it('serves the signal stream at GET /signals', async () => {
    const { base, channel } = await serve();
    const response = await fetch(`${base}/signals`);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

    channel.signal({ id: 's1', vehicleId: 'v7', tripId: 't', routeId: 'r', stopId: '7177-4660a5ff', at: 1_790_000_000_000, distanceM: 450, deadline: 1_790_000_022_444, waiting: 2 });

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect((await reader.read()).value).toBe('event: signal\ndata: {"id":"s1","vehicleId":"v7","tripId":"t","routeId":"r","stopId":"7177-4660a5ff","at":1790000000000,"distanceM":450,"deadline":1790000022444,"waiting":2,"route":"r","stopCode":"","stopName":"7177-4660a5ff"}\n\n');
  });

  it.each([
    ['GET', '/ack'],
    ['POST', '/signals'],
    ['GET', '/'],
  ])('answers %s %s with 404', async (method, path) => {
    const { base } = await serve();

    expect((await fetch(`${base}${path}`, { method })).status).toBe(404);
  });
});

// ADR-032: five routes, each body allow-listed and capped, the handle a UUID v4 that only ever travels in a body.
describe('hailServer, HailApi', () => {
  const handle = '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34';
  const stop = '7177-4660a5ff';
  const route = '30';

  it('applies POST /register as a register event, mapping the wire names to the event\'s', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/register`, JSON.stringify({ handle, stop, route, duration: 30 }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'register', handle, stopId: stop, routeId: route, leadTimeS: 30 }]);
  });

  it('applies POST /cancel as a cancel event naming the registration by handle, stop and route', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/cancel`, JSON.stringify({ handle, stop, route }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'cancel', handle, stopId: stop, routeId: route }]);
  });

  it('applies POST /presence/start as a presence-start event, with no device time', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/presence/start`, JSON.stringify({ handle, stop }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'presence-start', handle, stopId: stop }]);
  });

  it('applies POST /presence/end as a presence-end event, with no device time', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/presence/end`, JSON.stringify({ handle, stop }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'presence-end', handle, stopId: stop }]);
  });

  it('holds POST /outcomes open, sends each outcome for its handle, and submits connection-lost when it closes', async () => {
    const { base, applied, passengers } = await serve();
    const controller = new AbortController();
    const response = await post(`${base}/outcomes`, JSON.stringify({ handle }), controller.signal);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();

    passengers.outcome('a0000000-0000-4000-8000-000000000000', { stop, route, outcome: 'confirmed' });
    passengers.outcome(handle, { stop, route, outcome: 'unacknowledged' });

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect((await reader.read()).value).toBe('event: outcome\ndata: {"stop":"7177-4660a5ff","route":"30","outcome":"unacknowledged"}\n\n');
    expect(applied).toEqual([]);

    controller.abort();
    await until(() => applied.length > 0);
    expect(applied).toEqual([{ kind: 'connection-lost', handle }]);
  });

  // ADR-032, annotated 05-10-2026: only the last of a handle's open streams submits connection-lost on closing,
  // because a device that reconnects can hold a new stream before its old one's close reaches the server.
  it('submits nothing when one of a handle\'s two streams closes, and connection-lost when the last one does', async () => {
    const { base, applied, passengers } = await serve();
    const first = new AbortController();
    const last = new AbortController();
    await post(`${base}/outcomes`, JSON.stringify({ handle }), first.signal);
    const lastStream = await post(`${base}/outcomes`, JSON.stringify({ handle }), last.signal);
    const lastReader = lastStream.body!.pipeThrough(new TextDecoderStream()).getReader();

    first.abort();
    // Wait until the server has seen the first stream close, so a connection-lost from it would be here by now.
    await until(async () => (await new Promise<number>((resolve) => server.getConnections((_error, n) => resolve(n)))) === 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(applied).toEqual([]);

    // The stream still open keeps receiving its handle's outcomes.
    passengers.outcome(handle, { stop, route, outcome: 'confirmed' });
    expect((await lastReader.read()).value).toContain('"outcome":"confirmed"');

    last.abort();
    await until(() => applied.length > 0);
    expect(applied).toEqual([{ kind: 'connection-lost', handle }]);
  });

  // A throw from an event listener is uncaught, and an uncaught exception ends the process.
  it('keeps serving when applying the connection-lost event throws', async () => {
    let lost = 0;
    const { base } = await serve((event) => {
      if (event.kind === 'connection-lost') {
        lost++;
        throw new Error('apply failed');
      }
    });
    const controller = new AbortController();
    await post(`${base}/outcomes`, JSON.stringify({ handle }), controller.signal);

    controller.abort();
    await until(() => lost > 0);

    expect((await post(`${base}/presence/start`, JSON.stringify({ handle, stop }))).status).toBe(204);
  });

  it.each([
    ['/register', { handle, stop, route, duration: 30, lat: -36.86698 }],
    ['/register', { handle, stop, route, duration: 30, location: { latitude: -36.86698, longitude: 174.77468 } }],
    ['/cancel', { handle, stop, route, lon: 174.77468 }],
    ['/presence/start', { handle, stop, coordinates: [174.77468, -36.86698] }],
    ['/presence/end', { handle, stop, t: 1791000000000 }],
    ['/outcomes', { handle, latitude: -36.86698 }],
  ])('refuses %s with any key outside its allow-list, a coordinate under any name among them, and applies nothing', async (path, fields) => {
    const { base, applied } = await serve();

    expect((await post(`${base}${path}`, JSON.stringify(fields))).status).toBe(400);
    expect(applied).toEqual([]);
  });

  it.each([
    ['a handle that is not a UUID', { handle: 'passenger-1', stop, route, duration: 30 }],
    ['a UUID that is not version 4', { handle: '3f2b8c1e-9d4a-1e6b-8a2c-1b7d5e9f0a34', stop, route, duration: 30 }],
    ['a UUID whose variant is not RFC 9562\'s', { handle: '3f2b8c1e-9d4a-4e6b-ca2c-1b7d5e9f0a34', stop, route, duration: 30 }],
    ['a fractional duration', { handle, stop, route, duration: 2.5 }],
    ['a negative duration', { handle, stop, route, duration: -1 }],
    ['a duration given as a string', { handle, stop, route, duration: '30' }],
    ['an empty stop', { handle, stop: '', route, duration: 30 }],
    ['a missing route', { handle, stop, duration: 30 }],
  ])('refuses a registration with %s', async (_case, fields) => {
    const { base, applied } = await serve();

    expect((await post(`${base}/register`, JSON.stringify(fields))).status).toBe(400);
    expect(applied).toEqual([]);
  });

  it.each([
    ['/register', { stop, route, duration: 30 }],
    ['/cancel', { stop, route }],
    ['/presence/start', { stop }],
    ['/presence/end', { stop }],
    ['/outcomes', {}],
  ])('refuses %s from a handle not shaped as a UUID v4, the credential (ADR-032 decision 5)', async (path, fields) => {
    const { base, applied } = await serve();

    expect((await post(`${base}${path}`, JSON.stringify({ handle: 'passenger-1', ...fields }))).status).toBe(400);
    expect(applied).toEqual([]);
  });

  it('accepts the upper-case handle iOS writes, and a duration of 0', async () => {
    const { base, applied } = await serve();

    const response = await post(`${base}/register`, JSON.stringify({ handle: handle.toUpperCase(), stop, route, duration: 0 }));

    expect(response.status).toBe(204);
    expect(applied).toEqual([{ kind: 'register', handle: handle.toUpperCase(), stopId: stop, routeId: route, leadTimeS: 0 }]);
  });
});

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await condition())) await new Promise((resolve) => setImmediate(resolve));
}
