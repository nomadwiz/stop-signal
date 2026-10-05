// The committed fixtures are exactly what manifest.json names, and fit the 20 MB that #13 allows (ADR-030).
// CI holds no AWS credentials (ADR-014): this checks the fixtures against the manifest, and the owner checks the
// manifest against S3 by hand.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

interface Manifest { objects: { key: string; fixture: string; fixtureSha256: string }[]; timetable: { fixture: string; fixtureSha256: string } }

describe('replay fixtures', async () => {
  const manifest: Manifest = JSON.parse(await readFile(`${FIXTURES}manifest.json`, 'utf8'));
  const listed = [...manifest.objects, manifest.timetable];

  it('hash to the SHA-256 the manifest records for each', async () => {
    for (const { fixture, fixtureSha256 } of listed) {
      expect(createHash('sha256').update(await readFile(FIXTURES + fixture)).digest('hex'), fixture).toBe(fixtureSha256);
    }
  });

  it('are all named in the manifest, each with its S3 key', async () => {
    const files = (await readdir(FIXTURES, { recursive: true, withFileTypes: true })).filter((f) => f.isFile())
      .map((f) => relative(FIXTURES, join(f.parentPath, f.name)));
    expect(files.sort()).toEqual([...listed.map((f) => f.fixture), 'manifest.json'].sort());
    expect(manifest.objects.every((o) => /^raw\/\d{4}-\d{2}-\d{2}\/\d+\.pb\.gz$/.test(o.key))).toBe(true);
  });

  it('total at most 20,000,000 bytes', async () => {
    let total = 0;
    for (const { fixture } of listed) total += (await readFile(FIXTURES + fixture)).length;
    expect(total).toBeLessThanOrEqual(20_000_000);
  });
});
