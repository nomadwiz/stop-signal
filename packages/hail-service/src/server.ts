// The hail service's one HTTP server, on node:http with no framework (ADR-015 decision 1). Caddy terminates
// TLS in front of it (ADR-032). It routes the driver console's stream and acknowledgement (#44, #45) and
// HailApi's five routes (#48), and every request that changes state reaches the loop through submit() as
// one of ADR-031's events.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { driverChannel } from './driver-channel.ts';
import type { passengerChannel } from './passenger-channel.ts';

const MAX_BODY_BYTES = 1024;

const nonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;
// ADR-032 decision 5: a device-generated UUID v4. iOS writes it in upper case, so either case passes.
const uuidV4 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Whole seconds, 0 or more; the upper bound is the core's (ADR-032 decision 2).
const wholeSeconds = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

// Reads a JSON object whose keys are exactly the spec's, each passing its check, or answers 413 or 400 itself
// and returns undefined. Any other key is refused, so no field the spec does not name can reach the loop (QR8).
async function body(req: IncomingMessage, res: ServerResponse, spec: Record<string, (value: unknown) => boolean>) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' }).end();
      return undefined;
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    parsed = undefined;
  }
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).every((key) => Object.hasOwn(spec, key)) &&
    Object.entries(spec).every(([key, check]) => check((parsed as Record<string, unknown>)[key]));
  if (!valid) {
    res.writeHead(400).end();
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

type Ports = {
  channel: ReturnType<typeof driverChannel>;
  passengers: ReturnType<typeof passengerChannel>;
  submit: (event: HailEvent) => void;
};

async function route(req: IncomingMessage, res: ServerResponse, { channel, passengers, submit }: Ports): Promise<void> {
  const request = `${req.method} ${req.url}`;
  if (request === 'GET /signals') return channel.stream(res);
  // Each POST reads its body, then submits the event it maps to, answering 204.
  const accept = (event: HailEvent) => {
    submit(event);
    res.writeHead(204).end();
  };
  if (request === 'POST /ack') {
    const ack = await body(req, res, { signalId: nonEmptyString });
    if (ack) accept({ kind: 'console-ack', signalId: ack.signalId as string });
    return;
  }
  if (request === 'POST /register') {
    const registration = await body(req, res, { handle: uuidV4, stop: nonEmptyString, route: nonEmptyString, duration: wholeSeconds });
    if (registration) {
      const { handle, stop, route, duration } = registration as { handle: string; stop: string; route: string; duration: number };
      accept({ kind: 'register', handle, stopId: stop, routeId: route, leadTimeS: duration });
    }
    return;
  }
  if (request === 'POST /cancel') {
    const cancel = await body(req, res, { handle: uuidV4, stop: nonEmptyString, route: nonEmptyString });
    if (cancel) {
      const { handle, stop, route } = cancel as { handle: string; stop: string; route: string };
      accept({ kind: 'cancel', handle, stopId: stop, routeId: route });
    }
    return;
  }
  if (request === 'POST /presence/start' || request === 'POST /presence/end') {
    const presence = await body(req, res, { handle: uuidV4, stop: nonEmptyString });
    if (presence) {
      const { handle, stop } = presence as { handle: string; stop: string };
      accept({ kind: request === 'POST /presence/start' ? 'presence-start' : 'presence-end', handle, stopId: stop });
    }
    return;
  }
  if (request === 'POST /outcomes') {
    const outcomes = await body(req, res, { handle: uuidV4 });
    if (outcomes) passengers.stream(outcomes.handle as string, res);
    return;
  }
  res.writeHead(404).end();
}

export function hailServer(ports: Ports): Server {
  // A rejection here would be unhandled, which ends the process: a client that aborts its body, or an
  // event whose apply throws, costs that one request instead.
  return createServer((req, res) =>
    route(req, res, ports).catch(() => (res.headersSent ? res.destroy() : res.writeHead(500).end())),
  );
}
