/**
 * 261123 launch timing: phase marks (first stamp wins) and the renderer's
 * app_first_view props rebuilt in main (shape only).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstViewProps, markStartup, resetStartupMarksForTest, startupMark, startupMarkProps } from './startupMarks';

beforeEach(() => {
  resetStartupMarksForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('markStartup', () => {
  it('keeps the first stamp of a phase', () => {
    markStartup('window_created');
    const first = startupMark('window_created');
    expect(typeof first).toBe('number');
    markStartup('window_created');
    expect(startupMark('window_created')).toBe(first);
  });

  it('flattens the stamps into <phase>_ms props', () => {
    markStartup('ready');
    markStartup('ipc_ready');
    const props = startupMarkProps();
    expect(Object.keys(props).sort()).toEqual(['ipc_ready_ms', 'ready_ms']);
    expect(Number.isInteger(props.ready_ms)).toBe(true);
  });
});

describe('firstViewProps', () => {
  it('keeps known view kinds and stamps main time on arrival', () => {
    markStartup('window_created');
    const p = firstViewProps({ view_kind: 'home', waited_auth_ms: 12.4, renderer_ms: 900.6 }, 2345.6);
    expect(p).toMatchObject({
      view_kind: 'home',
      ms_since_process_start: 2346,
      waited_auth_ms: 12,
      renderer_ms: 901,
      first_of_process: true,
    });
    expect(p).toHaveProperty('window_created_ms');
  });

  it('maps unknown kinds to other and drops bad numbers', () => {
    const p = firstViewProps({ view_kind: 'user@example.com', waited_auth_ms: -1, renderer_ms: 'x' }, 10);
    expect(p.view_kind).toBe('other');
    expect(p).not.toHaveProperty('waited_auth_ms');
    expect(p).not.toHaveProperty('renderer_ms');
  });

  it('bounds huge timings and marks later reports as not the launch', () => {
    firstViewProps({ view_kind: 'home' }, 1);
    const p = firstViewProps({ view_kind: 'signin', waited_auth_ms: 1e12 }, 1);
    expect(p.first_of_process).toBe(false);
    expect(p.waited_auth_ms).toBe(30 * 60_000);
  });

  it('accepts a malformed payload', () => {
    expect(firstViewProps(null, 5)).toMatchObject({ view_kind: 'other', ms_since_process_start: 5 });
  });
});
