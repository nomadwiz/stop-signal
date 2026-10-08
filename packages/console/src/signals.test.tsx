import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Signal } from '../../hail-core/src/signal.ts';
import { acknowledge, SignalList, subscribe } from './signals.tsx';

const s1 = { id: 's1', vehicleId: 'v7', stopId: '7177-4660a5ff', deadline: 1_790_000_022_444, waiting: 1 };
const s2 = { id: 's2', vehicleId: 'v8', stopId: '7177-4660a5ff', deadline: 1_790_000_031_063, waiting: 1 };

// The stream as EventSource delivers it: a MessageEvent named after the server-sent event, its data the JSON line.
function stream(...events: [string, object][]): Signal[] {
  const source = new EventTarget();
  let shown: Signal[] = [];
  subscribe(source, (change) => (shown = change(shown)));
  for (const [name, data] of events) source.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  return shown;
}

describe('the console page', () => {
  it('shows each live signal with an acknowledge button', () => {
    const html = renderToStaticMarkup(<SignalList signals={stream(['signal', s1], ['signal', s2])} onAck={() => {}} />);

    expect(html).toContain('v7');
    expect(html).toContain('v8');
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it('updates a signal in place when a hail joins it, showing how many are waiting, never adding a second (#35)', () => {
    const shown = stream(['signal', s1], ['signal', s2], ['signal', { ...s1, waiting: 3 }]);

    expect(shown.map((signal) => [signal.id, signal.waiting])).toEqual([['s1', 3], ['s2', 1]]);
    expect(renderToStaticMarkup(<SignalList signals={shown} onAck={() => {}} />)).toContain('3 waiting');
  });

  it('removes a signal from the screen when its retraction arrives', () => {
    const html = renderToStaticMarkup(<SignalList signals={stream(['signal', s1], ['signal', s2], ['retract', { id: 's1' }])} onAck={() => {}} />);

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
