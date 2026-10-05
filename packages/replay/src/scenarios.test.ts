// The committed scenarios are what scenarios.ts builds from the committed fixtures, and every one is a sequence of
// HailEvents #16 can replay: ADR-031's shapes, UUID v4 handles (ADR-032), in time order (ADR-035 decision 5).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actualCalls } from '../../hail-service/src/actual-calls.ts';
import { loadServiceDay } from '../../hail-service/src/gtfs-static.ts';
import { PASSENGERS, scenarios, type Scenario } from '../../hail-service/src/scenarios.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const SCENARIOS = fileURLToPath(new URL('../scenarios/', import.meta.url));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS: Record<string, string[]> = {
  register: ['handle', 'kind', 'leadTimeS', 'routeId', 'stopId'],
  'presence-start': ['handle', 'kind', 'stopId'],
  'presence-end': ['handle', 'kind', 'stopId'],
};

describe('replay scenarios', async () => {
  const manifest = JSON.parse(await readFile(`${FIXTURES}manifest.json`, 'utf8'));
  const files = (await readdir(SCENARIOS, { recursive: true })).filter((f) => f.endsWith('.json')).sort();
  const read = async (f: string): Promise<Scenario> => JSON.parse(await readFile(SCENARIOS + f, 'utf8'));

  it('are exactly what scenarios.ts builds from the fixtures, byte for byte', async () => {
    const index = await loadServiceDay(`${FIXTURES}gtfs.zip`, manifest.day);
    const { calls, observed } = await actualCalls(index, `${FIXTURES}snapshots`, manifest.from, manifest.to);
    const expected = new Map<string, string>();
    for (const d of [5.8, 17.4]) {
      for (const n of PASSENGERS) {
        for (const s of scenarios(calls, observed, index, manifest.stopId, d, n)) expected.set(`d${d}/${s.calls[0].at}-n${n}.json`, JSON.stringify(s, null, 2) + '\n');
      }
    }
    expect(files).toEqual([...expected.keys()].sort());
    for (const f of files) expect(await readFile(SCENARIOS + f, 'utf8'), f).toBe(expected.get(f));
  });

  it('carry only ADR-031 events for the file\'s stop, with UUID v4 handles, in time order', async () => {
    for (const f of files) {
      const s = await read(f);
      expect(f, f).toBe(`d${s.dS}/${s.calls[0].at}-n${s.n}.json`);
      for (const [i, { at, event }] of s.events.entries()) {
        expect(Object.keys(event).sort(), f).toEqual(KEYS[event.kind]);
        expect('handle' in event && UUID_V4.test(event.handle), f).toBe(true);
        expect('stopId' in event && event.stopId, f).toBe(s.stopId);
        expect(at, f).toBeGreaterThanOrEqual(s.events[i - 1]?.at ?? -Infinity);
      }
    }
  });

  it('give each passenger a register, a presence-start at the same instant, and a presence-end at one of the arrival\'s calls', async () => {
    for (const f of files) {
      const s = await read(f);
      const byHandle = new Map<string, Scenario['events']>();
      for (const e of s.events) if ('handle' in e.event) byHandle.set(e.event.handle, [...byHandle.get(e.event.handle) ?? [], e]);
      expect(byHandle.size, f).toBe(s.n * new Set(s.calls.map((c) => c.routeId)).size);
      for (const [, [register, start, end]] of byHandle) {
        expect([register.event.kind, start.event.kind, end.event.kind], f).toEqual(['register', 'presence-start', 'presence-end']);
        expect(start.at, f).toBe(register.at);
        expect(s.calls.map((c) => c.at), f).toContain(end.at);
      }
    }
  });
});
