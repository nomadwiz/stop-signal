// Usage: PORT=8080 node packages/hail-service/src/main.ts
// Runs the hail service (ADR-032, annotated 05-10-2026): the decision loop on the system clock, the driver and
// passenger channels, and the one HTTP server, on 127.0.0.1 only, behind Caddy, which terminates TLS (#50).
import type { AddressInfo } from 'node:net';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import { driverChannel } from './driver-channel.ts';
import { passengerChannel } from './passenger-channel.ts';
import { hailServer } from './server.ts';

// A wakeup fires at most this long after its t: 1.7% of D's 5.8 s floor (ADR-032, annotated 05-10-2026).
const WAKE_INTERVAL_MS = 100;

// ponytail: the loop applies nothing until #32's lifecycle state machine becomes its apply.
const wakeups = scheduler<HailEvent>({ now: () => Date.now() }, eventLoop<HailEvent>(() => {}));
setInterval(wakeups.wake, WAKE_INTERVAL_MS);

const server = hailServer({ channel: driverChannel(), passengers: passengerChannel(wakeups.submit), submit: wakeups.submit });
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => {
  const { address, port } = server.address() as AddressInfo;
  console.log(`hail service listening on ${address}:${port}`);
});
