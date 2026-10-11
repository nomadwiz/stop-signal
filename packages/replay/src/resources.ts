// T10's resource run (#69, QR11): m1-revised.md §7.4 measures 4 and 5, over the fixture replay (#16).
// CPU: processor time per tick ÷ tick interval, target ≤ 0.5. Disk: bytes of decision log per approach, against B6's
// ≤ 20 MB of trace per corridor per day.
//
// Usage: node packages/replay/src/resources.ts
//   Replays every scenario under packages/replay/scenarios/ over the fixture window, timing each tick, then reads each
//   decision log under packages/replay/expected/, which `npm run replay:check` holds to the replay, and prints per D and N
//   `| N | Scenarios | Ticks | Processor time per tick, median / worst | Worst of time ÷ interval | Met |` and
//   `| N | Log bytes | Approaches | Bytes per approach | Approaches a day within 20 MB |`. About 40 s.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ServiceDay } from '../../hail-core/src/coordinator.ts';
import { records, replayRuns } from '../../hail-service/src/replay-runs.ts';
import { fixtures, inputs, replay, type Snapshot, type Timed } from './replay.ts';

// B6, read as 10^6 bytes to the MB, the smaller reading.
const B6_BYTES = 20_000_000;

// Each tick's processor time and the interval to the next tick; the last tick has none, so is left out. A tick's time is
// the loop's work from that tick until the next: the tick, the scenario events after it, and every wakeup that fires
// before each of those. Taken with process.cpuUsage() around each input as replay() pulls it, so it counts the whole
// process, garbage collection and the first ticks' compilation included, and the worst tick is an upper bound. Snapshot
// decoding is fixtures()'s, before the replay, and is not counted.
export function cpuPerTick(index: ServiceDay, snaps: readonly Snapshot[], events: readonly Timed[]) {
  const us: number[] = snaps.map(() => 0);
  function* timed() {
    // An event before the first tick is charged to it.
    let tick = -1;
    for (const input of inputs(snaps, events)) {
      if (input.event.kind === 'tick') tick++;
      const start = process.cpuUsage();
      yield input;
      const { user, system } = process.cpuUsage(start);
      us[Math.max(tick, 0)] += user + system;
    }
  }
  replay(index, timed());
  return snaps.slice(0, -1).map(({ at }, i) => ({ at, cpuMs: us[i] / 1000, intervalMs: snaps[i + 1].at - at }));
}

// The decision logs' bytes, each line and its newline as the file holds it, and the approaches they commit on: the
// distinct (vehicle, stop) pairs of each log's `committed` records (ADR-011 decision 1). A hail that never commits adds
// bytes and no approach, so its records are charged to the approaches that do.
export function bytesPerApproach(logs: readonly (readonly string[])[]) {
  let bytes = 0;
  let approaches = 0;
  for (const log of logs) {
    bytes += log.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    approaches += new Set(records(log).flatMap((r) => r.approach ?? [])).size;
  }
  return { bytes, approaches };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { index, snaps } = await fixtures();
  const runs = ['-n1.json', '-n5.json'].map((suffix) => replayRuns(suffix));
  const ms = (x: number) => `${x.toFixed(3)} ms`;
  for (const [i, { d }] of runs[0].entries()) {
    const cpu = ['| N | Scenarios | Ticks | Processor time per tick, median / worst | Worst of time ÷ interval | Met |', '| --- | --- | --- | --- | --- | --- |'];
    const disk = ['| N | Log bytes | Approaches | Bytes per approach | Approaches a day within 20 MB |', '| --- | --- | --- | --- | --- |'];
    for (const run of runs) {
      const { built, logs } = run[i];
      const ticks = built.flatMap((s) => cpuPerTick(index, snaps, s.events));
      const sorted = ticks.map((t) => t.cpuMs).sort((a, b) => a - b);
      const ratio = ticks.reduce((r, t) => Math.max(r, t.cpuMs / t.intervalMs), 0);
      cpu.push(`| ${built[0].n} | ${built.length} | ${ticks.length} | ${ms(sorted[Math.ceil(sorted.length / 2) - 1])} / ${ms(sorted[sorted.length - 1])} | ${ratio.toExponential(2)} | ${ratio <= 0.5 ? 'yes' : 'no'} |`);
      const { bytes, approaches } = bytesPerApproach(logs);
      disk.push(`| ${built[0].n} | ${bytes} | ${approaches} | ${(bytes / approaches).toFixed(0)} | ${Math.floor(B6_BYTES / (bytes / approaches))} |`);
    }
    console.log(`\nD = ${d.slice(1)} s\n\n${cpu.join('\n')}\n\n${disk.join('\n')}`);
  }
  const gaps = snaps.slice(1).map((s, i) => (s.at - snaps[i].at) / 1000);
  console.log(`\nThe tick interval is each snapshot's gap to the next: ${gaps.reduce((a, b) => Math.min(a, b))}–${gaps.reduce((a, b) => Math.max(a, b))} s in the fixture window.`);
  console.log('Growth per corridor per day is bytes per approach × approaches a day: [GAP: how many approaches the corridor sees in a day].');
}
