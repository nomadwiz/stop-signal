import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledge, onStreamEvent, SignalList } from './signals.tsx';

const s1 = { id: 's1', vehicleId: 'v7', stopId: '7177-4660a5ff' };
const s2 = { id: 's2', vehicleId: 'v8', stopId: '7177-4660a5ff' };

describe('the console page', () => {
  it('shows each live signal with an acknowledge button', () => {
    const shown = onStreamEvent(onStreamEvent([], 'signal', s1), 'signal', s2);

    const html = renderToStaticMarkup(<SignalList signals={shown} onAck={() => {}} />);

    expect(html).toContain('v7');
    expect(html).toContain('v8');
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it('removes a signal from the screen when its retraction arrives', () => {
    const shown = onStreamEvent(onStreamEvent(onStreamEvent([], 'signal', s1), 'signal', s2), 'retract', { id: 's1' });

    const html = renderToStaticMarkup(<SignalList signals={shown} onAck={() => {}} />);

    expect(html).not.toContain('v7');
    expect(html).toContain('v8');
  });
});

describe('acknowledge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the signal id to the relative /ack route', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);

    await acknowledge('s1');

    expect(fetch).toHaveBeenCalledWith('/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"signalId":"s1"}',
    });
  });
});
