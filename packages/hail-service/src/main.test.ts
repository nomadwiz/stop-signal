import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';

let service: ReturnType<typeof spawn> | undefined;
afterEach(() => service?.kill());

// The service as the host runs it: Node strips main.ts's types, and PORT=0 lets the OS pick a free port.
it('starts on 127.0.0.1 on PORT, answers a HailApi request, and logs the decision it leads to on stdout', async () => {
  service = spawn(process.execPath, ['packages/hail-service/src/main.ts'], { env: { ...process.env, PORT: '0' } });
  // One listener for the whole run: once flowing, stdout drops whatever arrives while nothing listens.
  let out = '';
  service.stdout!.on('data', (chunk) => (out += chunk));
  const exited = once(service, 'exit').then(([code]) => Promise.reject(new Error(`main.ts exited with ${code}`)));
  const until = async (text: RegExp) => {
    while (!text.test(out)) await Promise.race([once(service!.stdout!, 'data'), exited]);
  };
  await until(/listening on 127\.0\.0\.1:\d+/);
  exited.catch(() => {}); // afterEach's kill ends it, which is no failure.
  const [address] = out.match(/127\.0\.0\.1:\d+/)!;

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
  await until(/"kind":"registered".*\n/);
  const line = JSON.parse(out.split('\n').find((l) => l.includes('"kind":"registered"'))!);
  expect(line).toMatchObject({ seq: 1, kind: 'registered', hailId: 'h1', vehicleId: null, payload: { stopId: '7177-4660a5ff', routeId: '70', leadTimeS: 0 } });
});
