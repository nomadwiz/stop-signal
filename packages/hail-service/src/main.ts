// Usage: PORT=8080 node packages/hail-service/src/main.ts
// Runs the hail service (ADR-032, annotated 05-10-2026): the decision loop on the system clock, applying each event
// through the hail coordinator (#32), the driver and passenger channels, and the one HTTP server, on 127.0.0.1 only,
// behind Caddy, which terminates TLS (#50). Decisions are written to stdout as JSON Lines, and nothing else is.
import type { AddressInfo } from 'node:net';
import { hailCoordinator } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import { recorder } from '../../hail-core/src/trace.ts';
import { driverChannel } from './driver-channel.ts';
import type { StaticIndex } from './gtfs-static.ts';
import { passengerChannel } from './passenger-channel.ts';
import { hailServer } from './server.ts';

// A wakeup fires at most this long after its t: 1.7% of D's 5.8 s floor (ADR-032, annotated 05-10-2026).
const WAKE_INTERVAL_MS = 100;
// The deceleration behind QR1's 17.4 s bound (ADR-023 decision 2).
const DECEL_MPS2 = 0.9;
// How long a passenger is at the stop before a hail becomes eligible: an assumption the evaluation tests (ADR-041).
const DWELL_MS = 30_000;

const clock = { now: () => Date.now() };
const signals = driverChannel();
// ponytail: no live feed reaches the loop yet, so no hail resolves or commits; load the service day when the feed is wired.
// Typed as the StaticIndex loadServiceDay returns, so tsc checks it satisfies the coordinator's ServiceDay.
const day: StaticIndex = { day: '', previousDay: '', stops: new Map(), routes: new Map(), trips: new Map(), lateTrips: new Map(), tripsAtStop: new Map(), shapes: new Map() };
// ponytail: stdout, which a restart starts again at seq 1; ADR-017's open item on a file and a restarted seq is #50's.
const record = recorder(clock, { append: (r) => console.log(JSON.stringify(r)) });

const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
const apply = hailCoordinator({ clock, record, signals, schedule: wakeups.at, timetable: day, decelMps2: DECEL_MPS2, dwellMs: DWELL_MS });
setInterval(wakeups.wake, WAKE_INTERVAL_MS);

const server = hailServer({ channel: signals, passengers: passengerChannel(wakeups.submit), submit: wakeups.submit });
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => {
  const { address, port } = server.address() as AddressInfo;
  console.error(`hail service listening on ${address}:${port}`);
});
