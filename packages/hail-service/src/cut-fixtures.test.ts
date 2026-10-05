import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bindings from 'gtfs-realtime-bindings';
import { describe, expect, it } from 'vitest';
import { cutFeed, cutTimetable, timetableTrips } from './cut-fixtures.ts';
import { loadServiceDay } from './gtfs-static.ts';

const { FeedMessage } = bindings.transit_realtime;
const FIXTURE = fileURLToPath(new URL('../fixtures/gtfs.zip', import.meta.url));

const vehicle = (id: string, tripId?: string) => ({ id: `v ${id}`, vehicle: { vehicle: { id }, ...(tripId && { trip: { tripId } }) } });
const update = (tripId: string, vehicleId: string) => ({ id: `u ${tripId} ${vehicleId}`, tripUpdate: { trip: { tripId }, vehicle: { id: vehicleId } } });

describe('cutFeed', () => {
  it("keeps the corridor's trip updates, the vehicles on its trips or named by them, and every trip update naming a kept vehicle", () => {
    const feed = FeedMessage.fromObject({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1790967692 },
      entity: [
        update('T1', 'untagged'),
        vehicle('untagged'),
        // The vehicle's previous trip, off the corridor: kept, so ADR-024 still sees two names.
        update('T9', 'untagged'),
        vehicle('tagged', 'T2'),
        update('T8', 'tagged'),
        vehicle('elsewhere', 'T9'),
        update('T9', 'elsewhere'),
        // Named only by a trip off the corridor.
        vehicle('stranger'),
        update('T7', 'stranger'),
        { id: 'alert', alert: { headerText: { translation: [{ text: 'Detour' }] } } },
      ],
    });

    const cut = cutFeed(feed, new Set(['T1', 'T2']));

    expect(cut.header).toEqual(feed.header);
    expect(cut.entity.map((e) => e.id)).toEqual(['u T1 untagged', 'v untagged', 'u T9 untagged', 'v tagged', 'u T8 tagged']);
  });

  it('lets a missing vehicle id name no vehicle', () => {
    const feed = FeedMessage.fromObject({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1790967692 },
      entity: [update('T1', ''), { id: 'v none', vehicle: { vehicle: {}, position: { latitude: -36.9, longitude: 174.8 } } }, update('T9', '')],
    });

    expect(cutFeed(feed, new Set(['T1'])).entity.map((e) => e.id)).toEqual(['u T1 ']);
  });
});

describe('timetableTrips', () => {
  it("adds every trip a kept trip update names to the corridor's, so the join counts the updates the cut kept", () => {
    const cut = (entity: object[]) => FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0' }, entity });
    const cuts = [cut([update('T1', 'a'), vehicle('a'), update('T9', 'a')]), cut([update('T8', 'b'), vehicle('c', 'T2')])];

    expect([...timetableTrips(new Set(['T1', 'T2']), cuts)].sort()).toEqual(['T1', 'T2', 'T8', 'T9']);
  });
});

describe('cutTimetable', () => {
  it('keeps only the trips named, with their stop times, shapes, routes, stops and services', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cut-')), 'gtfs.zip');
    await writeFile(path, await cutTimetable(FIXTURE, new Set(['T-weekend'])));

    // A Saturday, on which T-midnight also runs.
    const index = await loadServiceDay(path, '20261003');

    expect([...index.trips.keys()]).toEqual(['T-weekend']);
    expect(index.trips.get('T-weekend')!.stopTimes.map((st) => st.stopId)).toEqual(['A', 'B']);
    expect([...index.stops.keys()]).toEqual(['A', 'B']);
    expect([...index.shapes.keys()]).toEqual(['S-weekend']);
    expect([...index.routes.keys()]).toEqual(['NX1']);
  });

  it('keeps quoted fields intact and the services that switch a trip on by date', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'cut-')), 'gtfs.zip');
    await writeFile(path, await cutTimetable(FIXTURE, new Set(['T-event'])));

    // Event runs only by calendar_dates.txt; 20261006's index holds 20261005's run as a late trip.
    const index = await loadServiceDay(path, '20261006');

    expect(index.trips.get('T-event')?.headsign).toBe('Eden Park "Gate A"');
    expect(index.stops.get('A')?.name).toBe('Lower Albert St, Stop A');
  });

  it('writes the same bytes on every run, so the manifest can hash them', async () => {
    expect((await cutTimetable(FIXTURE, new Set(['T-weekday']))).equals(await cutTimetable(FIXTURE, new Set(['T-weekday'])))).toBe(true);
  });
});
