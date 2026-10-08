// S9's replay harness (#16, QR9, T7): drives the production hail coordinator through recorded snapshots and a scenario's
// events on a clock set to each input's time, with the real loop and scheduler, and returns the decision log it writes.
//
// Usage: node packages/replay/src/replay.ts [--write]   (npm run replay:check)
//   Replays every scenario under packages/replay/scenarios/ (ADR-035) over the whole fixture window (ADR-030), and
//   compares each decision log byte for byte with packages/replay/expected/<the scenario's path, as .jsonl>. Lists every
//   log that differs or is missing and exits 1 if any does. --write writes the logs instead, to accept a change.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hailCoordinator, type ServiceDay } from '../../hail-core/src/coordinator.ts';
import type { HailEvent } from '../../hail-core/src/events.ts';
import { eventLoop, scheduler } from '../../hail-core/src/loop.ts';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { recorder } from '../../hail-core/src/trace.ts';
import { snapshots, vehicleReports } from '../../hail-service/src/gtfs-realtime.ts';
import { loadServiceDay } from '../../hail-service/src/gtfs-static.ts';
import type { Scenario } from '../../hail-service/src/scenarios.ts';

// The service's values, as main.ts sets them: ADR-023 decision 2's deceleration and ADR-041's dwell.
const DECEL_MPS2 = 0.9;
const DWELL_MS = 30_000;

// A replay input: an event that crosses the seam, at the instant it arrives. A snapshot is a tick at its capture time,
// and a scenario's events are already in this shape (ADR-035 decision 5).
export interface Timed { at: number; event: HailEvent }

// The snapshots as ticks, merged with the events in time order. The sort is stable, so on a tie the tick goes first.
export function inputs(snaps: readonly { at: number; reports: VehicleReport[] }[], events: readonly Timed[]): Timed[] {
  const ticks = snaps.map(({ at, reports }): Timed => ({ at, event: { kind: 'tick', reports } }));
  return [...ticks, ...events].sort((a, b) => a.at - b.at);
}

// One fresh coordinator applies every input through submit(), as the live adapters do (ADR-028 decision 1). Before each
// input, every wakeup due by then fires with the clock at its own t, as the live timer fires it to within 100 ms, so a
// replay never runs a commit late by the gap to the next snapshot. The replay ends at its last input, so a wakeup due
// after it never fires. Signals go nowhere: the log is what T7 compares.
// Each line is JSON.stringify of the record, as main.ts writes it, keys in ADR-017's order.
export function replay(timetable: ServiceDay, timed: readonly Timed[]): string[] {
  let now = -Infinity;
  const clock = { now: () => now };
  const log: string[] = [];
  const wakeups = scheduler<HailEvent>(clock, eventLoop<HailEvent>((e) => apply(e)));
  const apply = hailCoordinator({
    clock,
    record: recorder(clock, { append: (r) => log.push(JSON.stringify(r)) }),
    signals: { signal: () => {}, retract: () => {} },
    schedule: wakeups.at,
    timetable,
    decelMps2: DECEL_MPS2,
    dwellMs: DWELL_MS,
  });
  for (const { at, event } of timed) {
    for (let t = wakeups.next(); t <= at; t = wakeups.next()) {
      now = t;
      wakeups.wake();
    }
    now = at;
    wakeups.submit(event);
  }
  return log;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  const started = performance.now();
  const manifest = JSON.parse(readFileSync(here('fixtures/manifest.json'), 'utf8'));
  const index = await loadServiceDay(here('fixtures/gtfs.zip'), manifest.day);
  // Each snapshot is decoded once, as C7 would hand it to the loop: the whole decoded snapshot is one tick.
  const snaps = [];
  for await (const { at, feed } of snapshots(here('fixtures/snapshots'), manifest.from, manifest.to)) snaps.push({ at, reports: vehicleReports(feed, index) });
  const loaded = performance.now();

  const scenarios = readdirSync(here('scenarios'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json')).sort();
  const logs = scenarios.map((f) => f.replace(/\.json$/, '.jsonl'));
  const bad: string[] = [];
  for (const [i, f] of scenarios.entries()) {
    const scenario: Scenario = JSON.parse(readFileSync(here(`scenarios/${f}`), 'utf8'));
    const text = replay(index, inputs(snaps, scenario.events)).map((line) => `${line}\n`).join('');
    const path = here(`expected/${logs[i]}`);
    if (write) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    } else if (!existsSync(path) || readFileSync(path, 'utf8') !== text) bad.push(logs[i]);
  }
  // A log with no scenario left to replay it is stale, and fails the check too.
  const kept = new Set(logs);
  if (existsSync(here('expected'))) bad.push(...readdirSync(here('expected'), { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl') && !kept.has(f)));

  const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  console.log(`${scenarios.length} scenarios replayed over ${snaps.length} snapshots: ${s(loaded - started)} to load, ${s(performance.now() - loaded)} to replay.`);
  if (write) console.log(`Wrote ${logs.length} logs under ${here('expected')}.`);
  else if (bad.length) {
    console.error(`T7 fails: ${bad.length} decision logs differ from, or are missing in, packages/replay/expected/:\n${bad.map((f) => `  ${f}`).join('\n')}`);
    process.exit(1);
  } else console.log('T7 passes: every decision log is byte-identical to its expected log.');
}
