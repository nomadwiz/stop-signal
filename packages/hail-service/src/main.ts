// Usage: [AT_KEY=<subscription key>] [GTFS_ZIP=<gtfs.zip>] PORT=8080 node packages/hail-service/src/main.ts
//   With AT_KEY set, polls Auckland Transport's feed every 20 s into the loop (ADR-044); run it only for field-test
//   windows, since it shares capture's quota. Without it, polls nothing.
//   With GTFS_ZIP set, loads today's Auckland service day from that timetable before it listens (ADR-043); the host
//   restarts it at 04:00 to load the next. Without it, the timetable is empty and no vehicle resolves.
// Runs the hail service (ADR-032, annotated 05-10-2026): the decision loop on the system clock, applying each event
// through the hail coordinator (#32), the driver and passenger channels, and the one HTTP server, on 127.0.0.1 only,
// behind Caddy, which terminates TLS (#50). Decisions are written to stdout as JSON Lines, and nothing else is.
import type { AddressInfo } from 'node:net';
import { hailCoordinator } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import { recorder } from '../../hail-core/src/trace.ts';
import { POLL_MS } from '../../feed-capture/src/capture.ts';
import { driverChannel } from './driver-channel.ts';
import { pollFeed } from './gtfs-realtime.ts';
import { loadServiceDay, type StaticIndex } from './gtfs-static.ts';
import { passengerChannel } from './passenger-channel.ts';
import { hailServer } from './server.ts';

// A wakeup fires at most this long after its t: 1.7% of D's 5.8 s floor (ADR-032, annotated 05-10-2026).
const WAKE_INTERVAL_MS = 100;
// The deceleration behind QR1's 17.4 s bound (ADR-023 decision 2).
const DECEL_MPS2 = 0.9;
// How long a passenger is at the stop before a hail becomes eligible: an assumption the evaluation tests (ADR-041).
const DWELL_MS = 30_000;

const clock = { now: () => Date.now() };
// en-CA formats a date as YYYY-MM-DD.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(Date.now()).replaceAll('-', '');
const zip = process.env.GTFS_ZIP;
// Typed as the StaticIndex loadServiceDay returns, so tsc checks it satisfies the coordinator's ServiceDay.
const day: StaticIndex = zip
  ? await loadServiceDay(zip, today)
  : { day: '', previousDay: '', stops: new Map(), routes: new Map(), trips: new Map(), lateTrips: new Map(), tripsAtStop: new Map(), shapes: new Map() };
if (zip) console.error(`timetable ${zip}: service day ${day.day}, ${day.trips.size} trips, ${day.stops.size} stops`);
const signals = driverChannel(day);
// stdout, which a restart starts again at seq 1: the host writes each run to a file of its own (ADR-017, decided 11-10-2026).
const record = recorder(clock, { append: (r) => console.log(JSON.stringify(r)) });

const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
const passengers = passengerChannel(wakeups.submit);
const apply = hailCoordinator({ clock, record, signals, notify: passengers, schedule: wakeups.at, timetable: day, decelMps2: DECEL_MPS2, dwellMs: DWELL_MS });
setInterval(wakeups.wake, WAKE_INTERVAL_MS);

const key = process.env.AT_KEY;
if (key) {
  const poll = () => pollFeed({ key, fetchFeed: fetch, index: day, submit: wakeups.submit, log: console.error });
  void poll();
  setInterval(poll, POLL_MS);
}

const server = hailServer({ channel: signals, passengers, submit: wakeups.submit });
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => {
  const { address, port } = server.address() as AddressInfo;
  console.error(`hail service listening on ${address}:${port}`);
});
