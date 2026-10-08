// T6 (#42, FR14, QR7): the feed withheld mid-hail in replay reaches C5's watchdog. No gap between fixture snapshots
// exceeds 20.006 s, so the outage is made by removing snapshots, in memory: CI re-hashes every fixture (ADR-030
// decision 4).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEED_INTERVAL_MS } from '../../hail-core/src/predict.ts';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import { snapshots, vehicleReports } from '../../hail-service/src/gtfs-realtime.ts';
import { loadServiceDay } from '../../hail-service/src/gtfs-static.ts';
import type { Scenario } from '../../hail-service/src/scenarios.ts';
import { inputs, replay } from './replay.ts';

const here = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

describe('the feed withheld mid-hail over the fixtures', async () => {
  const manifest = JSON.parse(await readFile(here('fixtures/manifest.json'), 'utf8'));
  const index = await loadServiceDay(here('fixtures/gtfs.zip'), manifest.day);
  const snaps: { at: number; reports: VehicleReport[] }[] = [];
  for await (const { at, feed } of snapshots(here('fixtures/snapshots'), manifest.from, manifest.to)) snaps.push({ at, reports: vehicleReports(feed, index) });
  // Ten passengers on two routes at the first arrival at D = 17.4 s (ADR-035).
  const scenario: Scenario = JSON.parse(await readFile(here('scenarios/d17.4/1790960884710-n5.json'), 'utf8'));
  const run = (s: typeof snaps) => replay(index, inputs(s, scenario.events)).map((line) => JSON.parse(line));
  const baseline = run(snaps);

  // The feed stops at h1's eligible instant, mid-hail and before any commit, and resumes two feed intervals later: a
  // replay fires a wakeup only before a later input, so the outage has to end for the watchdog's wakeup to fire.
  const cut = baseline.find((r) => r.hailId === 'h1' && r.kind === 'eligible').at;
  const drill = run(snaps.filter((s) => s.at < cut || s.at >= cut + 2 * FEED_INTERVAL_MS));
  const lastTick = snaps.findLast((s) => s.at < cut)!.at;
  const warned = drill.filter((r) => r.kind === 'abandoned' && r.payload.reason === 'feed');

  it('replays the log unchanged up to the cut', () => {
    expect(drill.filter((r) => r.at < cut)).toEqual(baseline.filter((r) => r.at < cut));
  });

  it('warns every live hail at once, one feed interval and 1 ms after the last tick it received', () => {
    const live = new Set(drill.filter((r) => r.kind === 'registered').map((r) => r.hailId));
    expect(live.size).toBe(10);
    expect(warned.map((r) => r.hailId).sort()).toEqual([...live].sort());
    expect(new Set(warned.map((r) => r.at))).toEqual(new Set([lastTick + FEED_INTERVAL_MS + 1]));
  });

  it('commits nothing once the feed has been cut', () => {
    expect(drill.filter((r) => r.kind === 'committed')).toEqual([]);
  });
});
