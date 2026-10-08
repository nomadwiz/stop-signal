import { describe, expect, it } from 'vitest';
import type { Clock } from './clock.ts';
import { eventLoop, scheduler } from './loop.ts';

describe('eventLoop', () => {
  it('applies events in sequence order, numbering them from 1', () => {
    const applied: [string, number][] = [];
    const enqueue = eventLoop<string>((event, seq) => applied.push([event, seq]));

    enqueue('tick');
    enqueue('register');
    enqueue('ack');

    expect(applied).toEqual([['tick', 1], ['register', 2], ['ack', 3]]);
  });

  it('applies an event enqueued during another after it, and after those already queued', () => {
    const trace: string[] = [];
    const enqueue = eventLoop<string>((event) => {
      trace.push(`start ${event}`);
      if (event === 'a') {
        enqueue('b');
        enqueue('c');
      }
      if (event === 'b') enqueue('d');
      trace.push(`end ${event}`);
    });

    enqueue('a');

    expect(trace).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
  });

  it('keeps the events queued behind a throw, and applies them before the next event', () => {
    const applied: [string, number][] = [];
    const enqueue = eventLoop<string>((event, seq) => {
      if (event === 'bad') throw new Error('bad event');
      applied.push([event, seq]);
    });

    expect(() => enqueue('bad', 'queued')).toThrow('bad event');
    enqueue('good');

    expect(applied).toEqual([['queued', 2], ['good', 3]]);
  });
});

describe('scheduler', () => {
  it('fires a wakeup for t when the fake clock reaches t, not before', () => {
    let now = 0;
    const clock: Clock = { now: () => now };
    const fired: string[] = [];
    const wakeups = scheduler(clock, eventLoop<string>((event) => fired.push(event)));
    wakeups.at(100, 'deadline h1');

    now = 99;
    wakeups.wake();
    expect(fired).toEqual([]);

    now = 100;
    wakeups.wake();
    expect(fired).toEqual(['deadline h1']);

    now = 101;
    wakeups.wake();
    expect(fired).toEqual(['deadline h1']);
  });

  it('enqueues every due wakeup earliest first, and equal times in the order they were set', () => {
    let now = 0;
    const fired: string[] = [];
    const wakeups = scheduler({ now: () => now }, eventLoop<string>((event) => fired.push(event)));
    wakeups.at(300, 'third');
    wakeups.at(100, 'first');
    wakeups.at(200, 'second a');
    wakeups.at(200, 'second b');
    wakeups.at(400, 'not yet');

    now = 300;
    wakeups.wake();

    expect(fired).toEqual(['first', 'second a', 'second b', 'third']);
  });

  it('loses no due wakeup when applying an earlier one throws', () => {
    let now = 0;
    const fired: string[] = [];
    const enqueue = eventLoop<string>((event) => {
      if (event === 'bad') throw new Error('bad wakeup');
      fired.push(event);
    });
    const wakeups = scheduler({ now: () => now }, enqueue);
    wakeups.at(100, 'bad');
    wakeups.at(200, 'later');

    now = 200;
    expect(() => wakeups.wake()).toThrow('bad wakeup');
    enqueue('tick');

    expect(fired).toEqual(['later', 'tick']);
  });

  // ADR-028 decision 1: due wakeups enter the queue before the event that arrives, the wakeup first on a tie.
  it('submits an arriving event after every wakeup due by then: a wakeup at 100 and a tick at 100 apply as [wakeup, tick]', () => {
    let now = 0;
    const fired: string[] = [];
    const wakeups = scheduler({ now: () => now }, eventLoop<string>((event) => fired.push(event)));
    wakeups.at(100, 'wakeup');
    wakeups.at(101, 'not yet');

    // Detached, as an adapter is handed it.
    const { submit } = wakeups;
    now = 100;
    submit('tick');

    expect(fired).toEqual(['wakeup', 'tick']);
  });

  // ADR-002: in replay the loop fast-forwards, so the replay sets the clock to each wakeup's own t before waking it.
  it('says when the earliest wakeup not yet enqueued falls, and Infinity when none is held', () => {
    let now = 0;
    const wakeups = scheduler({ now: () => now }, eventLoop<string>(() => {}));
    expect(wakeups.next()).toBe(Infinity);
    wakeups.at(300, 'later');
    wakeups.at(100, 'first');
    expect(wakeups.next()).toBe(100);

    now = 100;
    wakeups.wake();

    expect(wakeups.next()).toBe(300);
  });

  it('refuses a wakeup whose time is not a number, which no Clock reading could ever reach', () => {
    const wakeups = scheduler({ now: () => 0 }, eventLoop<string>(() => {}));

    expect(() => wakeups.at(Number.NaN, 'lost')).toThrow(RangeError);
  });
});
