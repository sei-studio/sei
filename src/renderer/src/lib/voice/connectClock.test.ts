import { describe, it, expect } from 'vitest';
import { createCallConnectClock } from './connectClock';
import { callConnectProps, sanitizeCallConnect } from '@shared/callConnect';

function setup() {
  let t = 1000;
  let wall = 1_700_000_000_000;
  const clock = createCallConnectClock({ now: () => t, wallNow: () => wall });
  return {
    clock,
    at: (ms: number) => {
      t = 1000 + ms;
      wall = 1_700_000_000_000 + ms;
    },
    wallAt: (ms: number) => 1_700_000_000_000 + ms,
  };
}

describe('call connect clock (261127, T563)', () => {
  it('times a call from press to the opener being audible', () => {
    const { clock, at, wallAt } = setup();
    clock.start('sui');
    at(40);
    clock.mark('mic_permission_ms');
    clock.note({ greetPath: 'app' });
    at(90);
    clock.mark('setup_reads_ms');
    clock.note({ sttLocal: 'none' });
    at(350);
    clock.mark('mic_open_ms');
    at(420);
    clock.mark('stt_ready_ms');
    at(1900);
    clock.greetLine('sui', wallAt(300));
    at(1980);
    clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    clock.mark('opener_tts_ms'); // requested at connect (T571)
    at(2990);
    clock.mark('opener_tts_ms'); // the queue handoff's mark does not move it
    clock.mark('opener_queued_ms');
    at(3500);
    expect(clock.audible()).toBe(true);

    expect(clock.take('sui')).toEqual({
      mic_permission_ms: 40,
      setup_reads_ms: 90,
      mic_open_ms: 350,
      stt_ready_ms: 420,
      greet_request_ms: 300,
      greet_ready_ms: 1900,
      connect_ms: 1980,
      opener_tts_ms: 1980,
      opener_queued_ms: 2990,
      first_line_ms: 3500,
      gate: 'greeting',
      greet_path: 'app',
      stt_local: 'none',
    });
    // Taken once.
    expect(clock.take('sui')).toBeUndefined();
  });

  it('names what the connect waited on last', () => {
    const ring = setup();
    ring.clock.start('a');
    ring.at(200);
    ring.clock.mark('stt_ready_ms');
    ring.at(800);
    ring.clock.greetLine('a');
    ring.at(1300);
    ring.clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    expect(ring.clock.peek()?.gate).toBe('ring');

    const stt = setup();
    stt.clock.start('a');
    stt.at(900);
    stt.clock.greetLine('a');
    stt.at(4000);
    stt.clock.mark('stt_ready_ms');
    stt.clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    expect(stt.clock.peek()?.gate).toBe('setup');

    const late = setup();
    late.clock.start('a');
    late.at(6300);
    late.clock.connected({ minRingMs: 1300, greetingTimedOut: true });
    expect(late.clock.peek()?.gate).toBe('greeting_timeout');
    // The greeting can still land after a timed-out connect.
    late.at(7000);
    late.clock.greetLine('a');
    expect(late.clock.peek()?.greet_ready_ms).toBe(7000);
  });

  it('only counts the opener: nothing after the player spoke', () => {
    const { clock, at } = setup();
    clock.start('sui');
    at(1500);
    clock.connected({ minRingMs: 1300, greetingTimedOut: true });
    at(9000);
    clock.closeOpener(); // the player said something first
    clock.greetLine('sui');
    clock.mark('opener_tts_ms');
    clock.mark('opener_queued_ms');
    expect(clock.audible()).toBe(false);
    const t = clock.take('sui');
    expect(t?.connect_ms).toBe(1500);
    expect(t).not.toHaveProperty('first_line_ms');
    expect(t).not.toHaveProperty('opener_queued_ms');
    expect(t).not.toHaveProperty('opener_tts_ms');
    expect(t).not.toHaveProperty('greet_ready_ms');
  });

  it('a later audible clip is not the first line', () => {
    const { clock, at } = setup();
    clock.start('sui');
    at(1400);
    clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    at(2600);
    expect(clock.audible()).toBe(true);
    at(5000);
    expect(clock.audible()).toBe(false);
    expect(clock.peek()?.first_line_ms).toBe(2600);
  });

  it('nothing for a joiner, a call that never connected, or another companion', () => {
    const { clock, at } = setup();
    clock.start('sui');
    at(500);
    clock.mark('mic_open_ms');
    clock.greetLine('lyra'); // not the dialed companion
    expect(clock.peek()).not.toHaveProperty('greet_ready_ms');
    // Hung up while dialing: no connect, no timing.
    expect(clock.take('sui')).toBeUndefined();
    at(1400);
    clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    expect(clock.take('lyra')).toBeUndefined();
    expect(clock.take('sui')?.connect_ms).toBe(1400);
  });

  it('drops a greeting stamp from before the dial', () => {
    const { clock, at, wallAt } = setup();
    clock.start('sui');
    at(900);
    clock.greetLine('sui', wallAt(-50));
    const t = clock.peek();
    expect(t?.greet_ready_ms).toBe(900);
    expect(t).not.toHaveProperty('greet_request_ms');
  });

  it('records nothing before start or after reset', () => {
    const { clock } = setup();
    clock.mark('mic_open_ms');
    clock.connected({ minRingMs: 1300, greetingTimedOut: false });
    expect(clock.audible()).toBe(false);
    expect(clock.peek()).toBeUndefined();
    clock.start('sui');
    clock.reset();
    expect(clock.take('sui')).toBeUndefined();
  });
});

describe('voice_call_ended connect props', () => {
  it('names the headline numbers and prefixes the rest', () => {
    expect(
      callConnectProps({
        mic_permission_ms: 40,
        setup_reads_ms: 90,
        mic_open_ms: 350,
        stt_ready_ms: 420,
        greet_request_ms: 300,
        greet_ready_ms: 1900,
        connect_ms: 1980,
        opener_tts_ms: 1980,
        opener_queued_ms: 2990,
        first_line_ms: 3500,
        gate: 'greeting',
        greet_path: 'in_game',
        stt_local: 'eager',
      }),
    ).toEqual({
      connect_mic_permission_ms: 40,
      connect_setup_reads_ms: 90,
      connect_mic_open_ms: 350,
      connect_stt_ready_ms: 420,
      connect_greet_request_ms: 300,
      connect_greet_ready_ms: 1900,
      connect_ms: 1980,
      connect_opener_tts_ms: 1980,
      connect_opener_queued_ms: 2990,
      first_line_ms: 3500,
      connect_gate: 'greeting',
      connect_greet_path: 'in_game',
      connect_stt_local: 'eager',
    });
  });

  it('leaves out what was not measured, never zeros', () => {
    expect(callConnectProps(undefined)).toEqual({});
    expect(callConnectProps({ connect_ms: 1500 })).toEqual({ connect_ms: 1500 });
  });

  it('drops bad fields one by one (a bad value never fails the report)', () => {
    expect(
      sanitizeCallConnect({
        connect_ms: 1500,
        first_line_ms: -3,
        mic_open_ms: 1.5,
        stt_ready_ms: 10_000_000,
        greet_ready_ms: '900',
        gate: 'bogus',
        greet_path: 'app',
        stt_local: 'later',
        transcript: 'hello',
      }),
    ).toEqual({ connect_ms: 1500, greet_path: 'app' });
    expect(sanitizeCallConnect('x')).toBeUndefined();
    expect(sanitizeCallConnect({ gate: 'nope' })).toBeUndefined();
  });
});
