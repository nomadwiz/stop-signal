import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionRecord } from '../../hail-core/src/trace.ts';
import { fileTraceSink } from './trace-file.ts';

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'trace-')), 'decisions.jsonl');
}

const RECORDS: DecisionRecord[] = [
  { seq: 1, at: 1_000, kind: 'register', hailId: 'h1', vehicleId: null, payload: { stop: '8013', route: 'NX1' } },
  { seq: 2, at: 61_500, kind: 'signal', hailId: null, vehicleId: 'v9', payload: { hails: ['h1', 'h2'], note: 'quote " and\nbreak' } },
];

describe('fileTraceSink', () => {
  it('serialises the same record sequence to identical bytes twice', async () => {
    const [a, b] = [await tempPath(), await tempPath()];
    for (const path of [a, b]) {
      const sink = fileTraceSink(path);
      for (const record of RECORDS) sink.append(record);
    }

    expect(await readFile(a)).toEqual(await readFile(b));
  });

  it('writes one JSON line per record, keys in a fixed order whatever order the record was built in', async () => {
    const path = await tempPath();
    const sink = fileTraceSink(path);
    sink.append({ payload: {}, vehicleId: 'v9', hailId: 'h1', kind: 'commit', at: 5, seq: 3 });

    expect(await readFile(path, 'utf8')).toBe('{"seq":3,"at":5,"kind":"commit","hailId":"h1","vehicleId":"v9","payload":{}}\n');
  });

  it('appends to a log that already exists rather than replacing it', async () => {
    const path = await tempPath();
    fileTraceSink(path).append(RECORDS[0]);
    fileTraceSink(path).append(RECORDS[1]);

    expect((await readFile(path, 'utf8')).split('\n').map((line) => line && JSON.parse(line).seq)).toEqual([1, 2, '']);
  });
});
