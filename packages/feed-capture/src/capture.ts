// Polls AT's combined GTFS-Realtime feed and archives each raw response, decoding nothing (ADR-015 decision 3).
//
// Usage: AT_KEY=<subscription key> node packages/feed-capture/src/capture.ts <archive root>
//   Writes <root>/<UTC date>/<epoch-ms>.pb.gz every 20 s and logs one line per poll to stdout.
//   Each file is written as <name>.tmp, then renamed: anything syncing or watching the archive
//   reads only *.pb.gz, since a crash between the two steps leaves the .tmp behind.
//   Run it in one place at a time: two pollers halve the 35,000-calls-a-week quota (#9).
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const FEED_URL = 'https://api.at.govt.nz/realtime/legacy';
const POLL_MS = 20_000;
// Shorter than the poll, so a hung request never overlaps the next tick.
const TIMEOUT_MS = 15_000;

interface Capture {
  root: string;
  key: string;
  now: () => number;
  fetchFeed: typeof fetch;
  log: (line: string) => void;
}

export async function captureOnce({ root, key, now, fetchFeed, log }: Capture): Promise<void> {
  const at = now();
  const stamp = new Date(at).toISOString();
  try {
    const response = await fetchFeed(FEED_URL, {
      headers: { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/x-protobuf' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      // An unread body holds its socket open until garbage collection.
      await response.body?.cancel();
      log(`${stamp} ${response.status} not archived`);
      return;
    }
    const body = new Uint8Array(await response.arrayBuffer());
    const dir = join(root, stamp.slice(0, 10));
    const file = join(dir, `${at}.pb.gz`);
    await mkdir(dir, { recursive: true });
    // Rename is atomic, so a *.pb.gz is always a whole snapshot.
    await writeFile(`${file}.tmp`, gzipSync(body));
    await rename(`${file}.tmp`, file);
    log(`${stamp} ${response.status} ${body.length} bytes`);
  } catch (error) {
    // fetch reports every network failure as "fetch failed"; the reason is in its cause.
    const cause = error instanceof Error && error.cause ? ` (${error.cause})` : '';
    log(`${stamp} error ${error}${cause}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.env.AT_KEY;
  const root = process.argv[2];
  if (!key || !root) {
    console.error('Usage: AT_KEY=<key> node packages/feed-capture/src/capture.ts <archive root>');
    process.exit(1);
  }
  const tick = () => captureOnce({ root, key, now: Date.now, fetchFeed: fetch, log: console.log });
  void tick();
  setInterval(tick, POLL_MS);
}
