// S9's mutation check (#17, QR9): replay must observe its input, not only repeat itself. QAS-4 scopes it to a tick for
// the resolved vehicle inside the decision window, whose perturbation must change the log; a tick for an unrelated
// vehicle must not (Milestone 1's cold review, F14). The perturbation is made in memory: CI re-hashes every fixture
// (ADR-030 decision 4).
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { VehicleReport } from '../../hail-core/src/resolve.ts';
import type { Scenario } from '../../hail-service/src/scenarios.ts';
import { fixtures, here, inputs, replay } from './replay.ts';

describe('the mutation check over the fixtures', async () => {
  const { index, snaps } = await fixtures();
  // The first arrival at D = 17.4 s, queued on both time sources (ADR-035): two routes, one passenger each.
  const scenario: Scenario = JSON.parse(await readFile(here('scenarios/d17.4/1790960884710-n1.json'), 'utf8'));
  const run = (s: typeof snaps) => replay(index, inputs(s, scenario.events)).join('\n');
  const log = run(snaps);
  const baseline = log.split('\n').map((line) => JSON.parse(line));

  // h1's commit, and the tick that delivered the resolved vehicle's fix it rests on: the first snapshot carrying the fix
  // the vehicle reports in the last snapshot at or before the commit. A later snapshot only re-serves that fix.
  const eligible = baseline.find((r) => r.hailId === 'h1' && r.kind === 'eligible');
  const committed = baseline.find((r) => r.hailId === 'h1' && r.kind === 'committed');
  const of = (s: (typeof snaps)[number], vehicleId: string) => s.reports.find((r) => r.vehicleId === vehicleId);
  const fixAt = of(snaps.findLast((s) => s.at <= committed.at && of(s, committed.vehicleId))!, committed.vehicleId)!.at;
  const i = snaps.findIndex((s) => of(s, committed.vehicleId)?.at === fixAt);
  // Each perturbation replaces snapshot i alone, in a copy.
  const perturbed = (reports: VehicleReport[]) => snaps.with(i, { ...snaps[i], reports });

  it("perturbs a tick inside the decision window, after h1 becomes eligible and no later than its commit", () => {
    expect(snaps[i].at).toBeGreaterThan(eligible.at);
    expect(snaps[i].at).toBeLessThanOrEqual(committed.at);
  });

  it('changes the log when that tick loses the resolved vehicle', () => {
    expect(run(perturbed(snaps[i].reports.filter((r) => r.vehicleId !== committed.vehicleId)))).not.toBe(log);
  });

  it('changes the log when that tick shifts the resolved vehicle back to its previous fix', () => {
    const previous = of(snaps[i - 1], committed.vehicleId)!;
    const shifted = snaps[i].reports.map((r) => (r.vehicleId === committed.vehicleId ? { ...r, lat: previous.lat, lon: previous.lon } : r));
    expect(run(perturbed(shifted))).not.toBe(log);
  });

  it('leaves the log unchanged when that tick loses a vehicle on a route no passenger wants', () => {
    const wanted = new Set(scenario.calls.map((c) => c.routeId));
    const routeOf = (r: VehicleReport) => index.trips.get(r.tripId ?? '')?.routeId;
    const unrelated = snaps[i].reports.find((r) => routeOf(r) && !wanted.has(routeOf(r)!));
    expect(unrelated).toBeDefined();
    expect(run(perturbed(snaps[i].reports.filter((r) => r !== unrelated)))).toBe(log);
  });
});
