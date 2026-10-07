import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';

let service: ReturnType<typeof spawn> | undefined;
afterEach(() => service?.kill());

// The service as the host runs it: Node strips main.ts's types, and PORT=0 lets the OS pick a free port.
it('starts on 127.0.0.1 on PORT, answers a HailApi request, and logs the decision it leads to on stdout', async () => {
  service = spawn(process.execPath, ['packages/hail-service/src/main.ts'], { env: { ...process.env, PORT: '0' } });
  // One listener per stream for the whole run: once flowing, a stream drops whatever arrives while nothing listens.
  // The banner goes to stderr, because stdout is the decision log.
  const out = { stdout: '', stderr: '' };
  for (const name of ['stdout', 'stderr'] as const) service[name]!.on('data', (chunk) => (out[name] += chunk));
  const exited = once(service, 'exit').then(([code]) => Promise.reject(new Error(`main.ts exited with ${code}`)));
  const until = async (name: 'stdout' | 'stderr', text: RegExp) => {
    while (!text.test(out[name])) await Promise.race([once(service![name]!, 'data'), exited]);
  };
  await until('stderr', /listening on 127\.0\.0\.1:\d+/);
  exited.catch(() => {}); // afterEach's kill ends it, which is no failure.
  const [address] = out.stderr.match(/127\.0\.0\.1:\d+/)!;

  const response = await fetch(`http://${address}/presence/start`, {
    method: 'POST',
    body: JSON.stringify({ handle: '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34', stop: '7177-4660a5ff' }),
  });

  expect(response.status).toBe(204);

  // The loop applies it through the coordinator, which writes the decision to stdout as JSON Lines.
  await fetch(`http://${address}/register`, {
    method: 'POST',
    body: JSON.stringify({ handle: '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34', stop: '7177-4660a5ff', route: '70', duration: 0 }),
  });
  await until('stdout', /\n/);
  const line = JSON.parse(out.stdout.split('\n')[0]);
  expect(line).toMatchObject({ seq: 1, kind: 'registered', hailId: 'h1', vehicleId: null, payload: { stopId: '7177-4660a5ff', routeId: '70', leadTimeS: 0 } });
});
