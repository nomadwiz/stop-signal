import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { captureOnce, FEED_URL } from './capture.ts';

// 2026-10-01T06:16:10.123Z
const AT = 1790835370123;
const snapshot = new Uint8Array([0x0a, 0x0d, 0x0a, 0x03, 0x32, 0x2e, 0x30]);

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'capture-'));
}

describe('captureOnce', () => {
  it('asks AT for protobuf with the subscription key', async () => {
    let seen: Request | undefined;
    const fetchFeed = async (input: string | URL | Request, init?: RequestInit) => {
      seen = new Request(input, init);
      return new Response(snapshot);
    };

    await captureOnce({ root: await freshRoot(), key: 'test-key', now: () => AT, fetchFeed, log: () => {} });

    expect(seen?.url).toBe(FEED_URL);
    expect(seen?.headers.get('Ocp-Apim-Subscription-Key')).toBe('test-key');
    expect(seen?.headers.get('Accept')).toBe('application/x-protobuf');
  });

  it('bounds each request with a timeout, so a hung request cannot overlap the next poll', async () => {
    let seenInit: RequestInit | undefined;
    const fetchFeed = async (_input: string | URL | Request, init?: RequestInit) => {
      seenInit = init;
      return new Response(snapshot);
    };

    await captureOnce({ root: await freshRoot(), key: 'k', now: () => AT, fetchFeed, log: () => {} });

    expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it('writes the response gzipped to <root>/<UTC date>/<epoch-ms>.pb.gz', async () => {
    const root = await freshRoot();

    await captureOnce({ root, key: 'k', now: () => AT, fetchFeed: async () => new Response(snapshot), log: () => {} });

    expect(await readdir(join(root, '2026-10-01'))).toEqual([`${AT}.pb.gz`]);
    const written = gunzipSync(await readFile(join(root, '2026-10-01', `${AT}.pb.gz`)));
    expect(new Uint8Array(written)).toEqual(snapshot);
  });

  it('logs the status and the byte count of a capture', async () => {
    const lines: string[] = [];

    await captureOnce({ root: await freshRoot(), key: 'k', now: () => AT, fetchFeed: async () => new Response(snapshot), log: (l) => lines.push(l) });

    expect(lines).toEqual([`2026-10-01T06:16:10.123Z 200 ${snapshot.length} bytes`]);
  });

  it('writes nothing and logs the status when AT refuses the request', async () => {
    const root = await freshRoot();
    const lines: string[] = [];
    const refused = async () => new Response('{"statusCode":401}', { status: 401 });

    await captureOnce({ root, key: 'k', now: () => AT, fetchFeed: refused, log: (l) => lines.push(l) });

    expect(await readdir(root)).toEqual([]);
    expect(lines).toEqual(['2026-10-01T06:16:10.123Z 401 not archived']);
  });

  it('releases a refused response body, so a week of refusals holds no sockets open', async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const refused = async () => new Response(body, { status: 429 });

    await captureOnce({ root: await freshRoot(), key: 'k', now: () => AT, fetchFeed: refused, log: () => {} });

    expect(cancelled).toBe(true);
  });

  it('logs a failed fetch instead of throwing, so the next tick still runs', async () => {
    const lines: string[] = [];
    const offline = async (): Promise<Response> => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.at.govt.nz') });
    };

    await expect(
      captureOnce({ root: await freshRoot(), key: 'k', now: () => AT, fetchFeed: offline, log: (l) => lines.push(l) }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual(['2026-10-01T06:16:10.123Z error TypeError: fetch failed (Error: getaddrinfo ENOTFOUND api.at.govt.nz)']);
  });
});
