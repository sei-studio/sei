import { describe, expect, it } from 'vitest';
import { actFlagFromEnv, CONTROL_TOOL, controlEventNote, controlGoal } from './controlTool';
import { normalizeKey, parseCombo } from './keys';

describe('control tool', () => {
  it('is named control and takes a goal', () => {
    expect(CONTROL_TOOL.name).toBe('control');
    expect((CONTROL_TOOL.input_schema as { required: string[] }).required).toEqual(['goal']);
    expect(CONTROL_TOOL.description).not.toMatch(/—/);
  });
  it('reads the goal from an assistant turn', () => {
    expect(controlGoal([{ type: 'text' }, { type: 'tool_use', name: 'control', input: { goal: '  open settings ' } }])).toBe('open settings');
    expect(controlGoal([{ type: 'tool_use', name: 'remember', input: { text: 'x' } }])).toBeNull();
    expect(controlGoal([{ type: 'tool_use', name: 'control', input: { goal: '' } }])).toBeNull();
  });
  it('writes the completion event plainly', () => {
    const n = controlEventNote('open settings', { status: 'gave_up', steps: 1, summary: 'It needs a password' });
    expect(n).toMatch(/for "open settings" gave up after 1 step\. Status: gave_up\. It needs a password\. The screenshot/);
    expect(n).not.toMatch(/—/);
    expect(controlEventNote('x', { status: 'done', steps: 3, summary: '' })).toMatch(/finished after 3 steps\. Status: done\. The screenshot/);
  });
  it('is gated on macOS plus the dev flag', () => {
    expect(actFlagFromEnv({ SEI_BACKSEAT_ACT: '1' }, [], 'darwin')).toBe(true);
    expect(actFlagFromEnv({}, ['--sei-backseat-act'], 'darwin')).toBe(true);
    expect(actFlagFromEnv({ SEI_BACKSEAT_ACT: '1' }, [], 'win32')).toBe(false);
    expect(actFlagFromEnv({}, [], 'darwin')).toBe(false);
  });
});

describe('keys', () => {
  it('normalizes xdotool and browser spellings', () => {
    expect(normalizeKey('Return')).toBe('return');
    expect(normalizeKey('Enter')).toBe('return');
    expect(normalizeKey('Page_Down')).toBe('pagedown');
    expect(normalizeKey('ArrowUp')).toBe('up');
    expect(normalizeKey('left_shift')).toBe('shift');
    expect(normalizeKey('nope')).toBeNull();
  });
  it('parses combos', () => {
    expect(parseCombo('ctrl+shift+t')).toEqual({ key: 't', modifiers: ['ctrl', 'shift'] });
    expect(parseCombo('super+c')).toEqual({ key: 'c', modifiers: ['cmd'] });
    expect(parseCombo('cmd++')).toMatchObject({ error: expect.any(String) });
    expect(parseCombo('t+cmd')).toMatchObject({ error: expect.stringMatching(/not a modifier/) });
  });
});
