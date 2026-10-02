import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { downloadFeed, GTFS_URL, loadServiceDay, parseCsvLine } from './gtfs-static.ts';

// Built from fixtures/gtfs/*.txt, piped so every entry carries a data descriptor as AT's do,
// with calendar_dates.txt stored rather than deflated:
//   cd packages/hail-service/fixtures/gtfs && zip -q - -n _dates.txt *.txt | cat > ../gtfs.zip
const FIXTURE = fileURLToPath(new URL('../fixtures/gtfs.zip', import.meta.url));
// A Monday. School is removed and Event added by calendar_dates.txt; Ended's range closed on 30-09-2026.
const DAY = '20261005';
// The signature that opens each central-directory record; the last one found is trips.txt's.
const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

async function tempPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'gtfs-')), name);
}

// Writes a copy of the fixture changed by edit, and returns its path.
async function patched(name: string, edit: (zip: Buffer) => void): Promise<string> {
  const zip = await readFile(FIXTURE);
  edit(zip);
  const path = await tempPath(name);
  await writeFile(path, zip);
  return path;
}

describe('parseCsvLine', () => {
  it('splits a plain line on commas, keeping empty fields', () => {
    expect(parseCsvLine('a,,b,')).toEqual(['a', '', 'b', '']);
  });

  it('keeps a comma inside a quoted field', () => {
    expect(parseCsvLine('NX1,"Hibiscus Coast, via Northern Busway",0')).toEqual(['NX1', 'Hibiscus Coast, via Northern Busway', '0']);
  });

  it('reads a doubled quote inside a quoted field as one quote', () => {
    expect(parseCsvLine('"Eden Park ""Gate A""",1')).toEqual(['Eden Park "Gate A"', '1']);
  });

  it('reads an empty quoted field as empty', () => {
    expect(parseCsvLine('"",x')).toEqual(['', 'x']);
  });
});

describe('loadServiceDay', () => {
  it("returns a trip's stops ordered by numeric stop_sequence, whatever the file order", async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.trips.get('T-weekday')?.stopTimes).toEqual([
      { stopId: 'A', sequence: 1, arrival: 25200, departure: 25260 },
      { stopId: 'B', sequence: 2, arrival: 25950, departure: 25950 },
      { stopId: 'C', sequence: 10, arrival: 27600, departure: 27600 },
    ]);
  });

  it('keeps only the trips whose service runs that day, after calendar_dates exceptions', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect([...index.trips.keys()].sort()).toEqual(['T-event', 'T-weekday']);
  });

  it('reads times past midnight as seconds past the service day start', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.trips.get('T-event')?.stopTimes[0]?.arrival).toBe(25 * 3600 + 30 * 60);
  });

  it("maps each stop to the day's trips that call there", async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.tripsAtStop.get('A')).toEqual(['T-weekday', 'T-event']);
    expect(index.tripsAtStop.get('C')).toEqual(['T-weekday']);
  });

  it('lists a trip once at a stop it calls at twice', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.tripsAtStop.get('B')).toEqual(['T-weekday', 'T-event']);
  });

  it('leaves the times of a stop that is not a timepoint empty', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.trips.get('T-event')?.stopTimes[2]).toEqual({ stopId: 'B', sequence: 3, arrival: undefined, departure: undefined });
  });

  it('reads quoted fields, a byte-order mark and CRLF line ends', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect(index.trips.get('T-weekday')).toMatchObject({ routeId: 'NX1', headsign: 'Hibiscus Coast, via Northern Busway', directionId: 0 });
    expect(index.trips.get('T-event')?.headsign).toBe('Eden Park "Gate A"');
    expect(index.stops.get('C')).toEqual({ id: 'C', code: '1003', name: 'Hibiscus Coast Station', lat: -36.6056, lon: 174.6989 });
  });

  it('keeps every stop and route, and only the shapes of kept trips, in sequence order', async () => {
    const index = await loadServiceDay(FIXTURE, DAY);

    expect([...index.stops.keys()]).toEqual(['A', 'B', 'C']);
    expect(index.routes.get('NX1')).toEqual({ id: 'NX1', shortName: 'NX1', type: 3 });
    expect([...index.shapes.keys()].sort()).toEqual(['S-busway', 'S-event']);
    expect(index.shapes.get('S-busway')?.map((p) => p.sequence)).toEqual([1, 2, 10]);
  });

  it('rejects a day not written as YYYYMMDD', async () => {
    await expect(loadServiceDay(FIXTURE, '2026-10-05')).rejects.toThrow('YYYYMMDD');
  });

  it('rejects a day that does not exist, rather than rolling it into the next month', async () => {
    await expect(loadServiceDay(FIXTURE, '20260231')).rejects.toThrow('YYYYMMDD');
  });

  it('rejects a file that is not a zip', async () => {
    const path = await tempPath('not.zip');
    await writeFile(path, 'not a zip');

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('zip');
  });

  it('rejects an encrypted entry rather than misreading it', async () => {
    const path = await patched('encrypted.zip', (zip) => {
      const central = zip.lastIndexOf(CENTRAL);
      zip.writeUInt16LE(zip.readUInt16LE(central + 8) | 1, central + 8);
    });

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('encrypted');
  });

  it('rejects a compression method other than stored or deflated', async () => {
    const path = await patched('bzip2.zip', (zip) => zip.writeUInt16LE(12, zip.lastIndexOf(CENTRAL) + 10));

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('compression method 12');
  });

  it('rejects a ZIP64 entry rather than misreading its offset', async () => {
    const path = await patched('zip64.zip', (zip) => zip.writeUInt32LE(0xffffffff, zip.lastIndexOf(CENTRAL) + 42));

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('ZIP64');
  });

  it('rejects an empty file rather than loading an empty day', async () => {
    // The name's last occurrence is in its central record, 46 bytes in; a zero size there empties it.
    const path = await patched('empty.zip', (zip) => zip.writeUInt32LE(0, zip.lastIndexOf('calendar_dates.txt') - 46 + 20));

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('calendar_dates.txt in ' + path + ' is empty');
  });

  it('rejects a file that lacks a column it reads, rather than loading an empty day', async () => {
    // calendar_dates.txt is stored, so its header can be renamed in place.
    const path = await patched('renamed.zip', (zip) => zip.write('exception_kind', zip.indexOf('exception_type')));

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('calendar_dates.txt in ' + path + ' lacks exception_type');
  });

  it('rejects a corrupt deflated entry rather than stopping short', async () => {
    // The first entry, calendar.txt, is deflated; its data follows the 30-byte header, name and extra field.
    const path = await patched('corrupt.zip', (zip) => {
      const data = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
      zip.fill(0xff, data, data + 4);
    });

    await expect(loadServiceDay(path, DAY)).rejects.toThrow('invalid');
  });
});

describe('downloadFeed', () => {
  it('writes the response body to the destination', async () => {
    const dest = await tempPath('gtfs.zip');
    let asked = '';
    const fetchFeed = async (input: string | URL | Request) => {
      asked = String(input);
      return new Response('zip bytes');
    };

    await downloadFeed(dest, fetchFeed);

    expect(asked).toBe(GTFS_URL);
    expect(await readFile(dest, 'utf8')).toBe('zip bytes');
  });

  it('bounds the request with a timeout, so a hung download fails', async () => {
    const dest = await tempPath('gtfs.zip');
    let seen: RequestInit | undefined;
    const fetchFeed = async (_input: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response('zip bytes');
    };

    await downloadFeed(dest, fetchFeed);

    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves nothing at the destination when the body fails mid-download', async () => {
    const dest = await tempPath('gtfs.zip');
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half a zip'));
        controller.error(new Error('connection reset'));
      },
    });

    await expect(downloadFeed(dest, async () => new Response(body))).rejects.toThrow('connection reset');
    expect(existsSync(dest)).toBe(false);
  });

  it('throws on a refused request', async () => {
    const dest = await tempPath('gtfs.zip');

    await expect(downloadFeed(dest, async () => new Response('', { status: 503 }))).rejects.toThrow('503');
  });
});
