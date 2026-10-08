// The correctness oracle (ADR-018) over the committed fixtures (ADR-030): what M1 scores the replay's commits against.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actualCalls, agreement, observedKey, TOLERANCE_MS } from '../../hail-service/src/actual-calls.ts';
import { loadServiceDay } from '../../hail-service/src/gtfs-static.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

describe('the oracle over the fixtures', async () => {
  const manifest = JSON.parse(await readFile(`${FIXTURES}manifest.json`, 'utf8'));
  const index = await loadServiceDay(`${FIXTURES}gtfs.zip`, manifest.day);
  const { calls, observed } = await actualCalls(index, `${FIXTURES}snapshots`, manifest.from, manifest.to);
  const atStop = calls.filter((c) => c.stopId === manifest.stopId);

  it("gives a call for every stop AT observed at the field-test stop, and agrees with AT within 20 s on at least 95% of them (ADR-018 decision 10's bar)", () => {
    const stopOf = (key: string) => {
      const [tripId, , sequence] = key.split('|');
      return index.trips.get(tripId)?.stopTimes.find((st) => st.sequence === Number(sequence))?.stopId;
    };
    const seen = [...observed.keys()].filter((key) => stopOf(key) === manifest.stopId);
    const called = new Set(atStop.map(observedKey));

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((key) => !called.has(key))).toEqual([]);
    expect(agreement(atStop, observed, TOLERANCE_MS, index).share).toBeGreaterThanOrEqual(0.95);
  });

  it("agrees with AT within 20 s on at least 95% of every stop compared on the fixtures' trips", () => {
    expect(agreement(calls, observed, TOLERANCE_MS, index).share).toBeGreaterThanOrEqual(0.95);
  });
});
