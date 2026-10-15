// cutStops' three rules: no pickup at a trip's last stop or on a pickup_type 1 call, and each route's commonest
// headsign at a stop, ties to the first alphabetically. The last test checks the bundled stops.json is the cut of
// the timetable the service loads, which CI does not hold; run it with that file downloaded from the archive bucket:
//   aws s3 cp s3://<bucket>/deploy/service/gtfs.zip <dir>/gtfs.zip --profile stopsignal
//   GTFS_ZIP=<dir>/gtfs.zip npx vitest run ios/cut-stops.test.ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { cutStops, readTimetable } from './cut-stops.ts';

const stop = (id: string) => ({ stop_id: id, stop_code: id, stop_name: `Stop ${id}`, stop_lat: '-36.8', stop_lon: '174.7', start_date: '20260917', end_date: '20261231' });
const call = (trip: string, id: string, sequence: number, pickup = '0') => ({ trip_id: trip, stop_id: id, stop_sequence: String(sequence), pickup_type: pickup });

it('lists a route only where its trips pick up, under its commonest headsign there', () => {
  const cut = cutStops({
    routes: [{ route_id: '70-205', route_short_name: '70' }],
    trips: [
      { trip_id: 'a', route_id: '70-205', trip_headsign: 'Botany To Britomart' },
      { trip_id: 'b', route_id: '70-205', trip_headsign: 'Botany To Britomart' },
      { trip_id: 'c', route_id: '70-205', trip_headsign: 'Botany To Panmure' },
    ],
    // A calls at M, then a drop-off-only stop D, then ends at E; b and c call at M then end at T.
    stopTimes: [call('a', 'E', 3), call('a', 'M', 1), call('a', 'D', 2, '1'), call('b', 'M', 1), call('b', 'T', 2), call('c', 'M', 1), call('c', 'T', 2)],
    stops: ['D', 'E', 'M', 'T'].map(stop),
  }, 'M');

  expect(cut.stops.map((s) => s.id)).toEqual(['M']);
  expect(cut.stops[0].routes).toEqual([{ id: '70-205', shortName: '70', headsign: 'Botany To Britomart' }]);
  expect(cut).toMatchObject({ routes: ['70'], from: '20260917', to: '20261231' });
});

it('breaks a headsign tie alphabetically', () => {
  const cut = cutStops({
    routes: [{ route_id: 'INN-202', route_short_name: 'INN' }],
    trips: [
      { trip_id: 'a', route_id: 'INN-202', trip_headsign: 'Inner Link Clockwise' },
      { trip_id: 'b', route_id: 'INN-202', trip_headsign: 'Inner Link Anticlockwise' },
    ],
    stopTimes: [call('a', 'M', 1), call('a', 'T', 2), call('b', 'M', 1), call('b', 'T', 2)],
    stops: ['M', 'T'].map(stop),
  }, 'M');

  expect(cut.stops[0].routes[0].headsign).toBe('Inner Link Anticlockwise');
});

// #176 acceptances 2 and 3: stops.json is the cut of the deployed service's timetable, so every stop id in it is a row
// of that timetable's stops.txt (ADR-043 decision 2).
it.runIf(process.env.GTFS_ZIP)('holds the cut of GTFS_ZIP through Melrose Street', async () => {
  const bundled = JSON.parse(readFileSync(new URL('StopSignal/stops.json', import.meta.url), 'utf8'));

  expect(bundled.stops).toEqual(cutStops(await readTimetable(process.env.GTFS_ZIP!), '7177-4660a5ff').stops);
});
