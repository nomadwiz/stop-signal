// The hail service's one HTTP server, on node:http with no framework (ADR-015 decision 1). Caddy terminates
// TLS in front of it (ADR-032). It routes the driver console's stream and acknowledgement (#44, #45), and every
// request that changes state reaches the loop through submit() as one of ADR-031's events.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HailEvent } from '../../hail-core/src/events.ts';
import type { driverChannel } from './driver-channel.ts';

const MAX_BODY_BYTES = 1024;

const nonEmptyString = (value: unknown) => typeof value === 'string' && value.length > 0;

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

type Ports = { channel: ReturnType<typeof driverChannel>; submit: (event: HailEvent) => void };

async function route(req: IncomingMessage, res: ServerResponse, { channel, submit }: Ports): Promise<void> {
  const request = `${req.method} ${req.url}`;
  if (request === 'GET /signals') return channel.stream(res);
  if (request === 'POST /ack') {
    const ack = await body(req, res, { signalId: nonEmptyString });
    if (!ack) return;
    submit({ kind: 'console-ack', signalId: ack.signalId as string });
    return void res.writeHead(204).end();
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
