import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import { driverChannel } from './driver-channel.ts';
import { hailServer } from './server.ts';

let server: Server;
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

// The real loop behind the server, so a test sees what the loop applies, not what the adapter meant to send.
// A test may pass its own submit instead.
async function serve(submit?: (event: HailEvent) => void): Promise<{ base: string; applied: HailEvent[]; channel: ReturnType<typeof driverChannel> }> {
  const applied: HailEvent[] = [];
  const wakeups = scheduler<HailEvent>({ now: () => 0 }, eventLoop((event) => applied.push(event)));
  const channel = driverChannel();
  server = hailServer({ channel, submit: submit ?? wakeups.submit });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, applied, channel };
}

const post = (url: string, body: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

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

    channel.signal({ id: 's1', vehicleId: 'v7', stopId: '7177-4660a5ff' });

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect((await reader.read()).value).toBe('event: signal\ndata: {"id":"s1","vehicleId":"v7","stopId":"7177-4660a5ff"}\n\n');
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
