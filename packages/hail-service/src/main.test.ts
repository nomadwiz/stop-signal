import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';

let service: ReturnType<typeof spawn> | undefined;
afterEach(() => service?.kill());

// The service as the host runs it: Node strips main.ts's types, and PORT=0 lets the OS pick a free port.
it('starts on 127.0.0.1 on PORT and answers a HailApi request', async () => {
  service = spawn(process.execPath, ['packages/hail-service/src/main.ts'], { env: { ...process.env, PORT: '0' } });
  let out = '';
  const exited = once(service, 'exit').then(([code]) => Promise.reject(new Error(`main.ts exited with ${code}`)));
  while (!/listening on 127\.0\.0\.1:\d+/.test(out)) out += (await Promise.race([once(service.stdout!, 'data'), exited]))[0];
  exited.catch(() => {}); // afterEach's kill ends it, which is no failure.
  const [address] = out.match(/127\.0\.0\.1:\d+/)!;

  const response = await fetch(`http://${address}/presence/start`, {
    method: 'POST',
    body: JSON.stringify({ handle: '3f2b8c1e-9d4a-4e6b-8a2c-1b7d5e9f0a34', stop: '7177-4660a5ff' }),
  });

  expect(response.status).toBe(204);
});
