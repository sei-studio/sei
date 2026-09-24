import { describe, expect, it } from 'vitest';
import { ACT_TOOLS, ActionSchemas, blockedCombo, describeAction, parseAction, toHelperCommand, type ParsedAction } from './actions';
import { parseCombo } from './keys';

const frame = { rect: { x: 1512, y: 25, w: 1200, h: 800 }, width: 1280, height: 853 };

function parsed(name: string, input: unknown): ParsedAction {
  const r = parseAction(name, input);
  if (!r.ok) throw new Error(r.error);
  return r.action;
}

describe('tool set', () => {
  it('exposes exactly the basic controls plus choose/say/done/give_up', () => {
    expect(ACT_TOOLS.map((t) => t.name).sort()).toEqual(
      ['choose', 'click', 'done', 'double_click', 'drag', 'give_up', 'hold_key', 'key', 'move', 'say', 'scroll', 'type', 'wait'].sort(),
    );
    for (const t of ACT_TOOLS) expect(ActionSchemas).toHaveProperty(t.name);
  });

  it('rejects unknown tools and bad input with a reason', () => {
    expect(parseAction('zoom', {})).toMatchObject({ ok: false });
    const r = parseAction('click', { x: 'a' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/x/);
    expect(parseAction('click', { x: 1, y: 2, button: 'middle' }).ok).toBe(false);
    expect(parseAction('hold_key', { key: 'w', ms: 60_000 }).ok).toBe(false);
    expect(parseAction('wait', { ms: 10 }).ok).toBe(false);
  });
});

describe('toHelperCommand', () => {
  it('maps a click through the frame and defaults to left', () => {
    const m = toHelperCommand(parsed('click', { x: 640, y: 426 }), frame);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    expect(m.command).toMatchObject({ cmd: 'click', button: 'left', count: 1 });
    const c = m.command as { x: number; y: number };
    expect(c.x).toBeCloseTo(1512 + 640.5 * (1200 / 1280), 5);
    expect(m.touch.points).toHaveLength(1);
  });

  it('clamps off-image coordinates into the shared bounds instead of refusing', () => {
    const m = toHelperCommand(parsed('click', { x: 5000, y: -40, button: 'right' }), frame);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    const c = m.command as { x: number; y: number; button: string };
    expect(c.button).toBe('right');
    expect(c.x).toBeLessThanOrEqual(1512 + 1200);
    expect(c.y).toBeGreaterThanOrEqual(25);
  });

  it('double click, drag, move', () => {
    const d = toHelperCommand(parsed('double_click', { x: 1, y: 1 }), frame);
    expect(d.ok && d.command).toMatchObject({ cmd: 'click', count: 2 });
    const g = toHelperCommand(parsed('drag', { from_x: 0, from_y: 0, to_x: 2000, to_y: 2000 }), frame);
    expect(g.ok && g.touch.points).toHaveLength(2);
    if (g.ok) {
      const c = g.command as { to: [number, number] };
      expect(c.to[0]).toBeLessThanOrEqual(1512 + 1200);
    }
    expect(toHelperCommand(parsed('move', { x: 3, y: 3 }), frame)).toMatchObject({ ok: true, command: { cmd: 'move' } });
  });

  it('scroll up is positive dy, down negative', () => {
    const up = toHelperCommand(parsed('scroll', { x: 10, y: 10, direction: 'up' }), frame);
    const down = toHelperCommand(parsed('scroll', { x: 10, y: 10, direction: 'down', amount: 5 }), frame);
    expect(up.ok && up.command).toMatchObject({ dy: 3, dx: 0 });
    expect(down.ok && down.command).toMatchObject({ dy: -5 });
  });

  it('marks keyboard and typing touches', () => {
    const t = toHelperCommand(parsed('type', { text: 'hi' }), frame);
    expect(t.ok && t.touch).toMatchObject({ keyboard: true, typing: true, points: [] });
    const k = toHelperCommand(parsed('key', { keys: 'cmd+c' }), frame);
    expect(k.ok && k.touch).toMatchObject({ keyboard: true, typing: false });
    const letter = toHelperCommand(parsed('key', { keys: 'a' }), frame);
    expect(letter.ok && letter.touch.typing).toBe(true);
    const h = toHelperCommand(parsed('hold_key', { key: 'W', ms: 500 }), frame);
    expect(h.ok && h.command).toEqual({ cmd: 'hold', key: 'w', ms: 500 });
  });

  it('wait touches nothing', () => {
    const w = toHelperCommand(parsed('wait', { ms: 500 }), frame);
    expect(w.ok && w.touch).toEqual({ points: [], keyboard: false, typing: false });
  });

  it('refuses quit, force quit, logout and lock combos', () => {
    for (const combo of ['cmd+q', 'Command+Q', 'cmd+option+esc', 'cmd+alt+shift+escape', 'cmd+shift+q', 'cmd+alt+shift+q', 'ctrl+cmd+q']) {
      const r = toHelperCommand(parsed('key', { keys: combo }), frame);
      expect(r.ok, combo).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/refused/);
    }
    for (const combo of ['cmd+w', 'cmd+c', 'escape', 'q', 'alt+escape', 'cmd+shift+t']) {
      expect(toHelperCommand(parsed('key', { keys: combo }), frame).ok, combo).toBe(true);
    }
  });

  it('blockedCombo works on helper names', () => {
    const c = parseCombo('cmd+option+esc');
    if ('error' in c) throw new Error(c.error);
    expect(blockedCombo(c.key, c.modifiers)).toBe('force quit');
    expect(blockedCombo('power', [])).toMatch(/shut down/);
  });

  it('refuses unknown keys with the part that was wrong', () => {
    const r = toHelperCommand(parsed('key', { keys: 'cmd+banana' }), frame);
    expect(r).toMatchObject({ ok: false });
  });

  it('describes actions in one line', () => {
    expect(describeAction(parsed('click', { x: 10.4, y: 20.6, button: 'right' }))).toBe('right click (10, 21)');
    expect(describeAction(parsed('type', { text: 'x'.repeat(50) }))).toMatch(/\.\.\."$/);
  });
});
