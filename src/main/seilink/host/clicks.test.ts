import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClickClassifier } from './clicks';

function make() {
  const onClick = vi.fn();
  const onDoubleClick = vi.fn();
  const onDrag = vi.fn();
  const c = new ClickClassifier({ dblMs: 500, dragPx: 6, onClick, onDoubleClick, onDrag });
  return { c, onClick, onDoubleClick, onDrag };
}

describe('seilink click classifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds a single click for the double-click interval', () => {
    const { c, onClick } = make();
    c.press({ x: 10, y: 10, t: 0 }, { x: 11, y: 10, t: 80 });
    vi.advanceTimersByTime(499);
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a second press in time is a double click and the single one never fires (Windows)', () => {
    const { c, onClick, onDoubleClick } = make();
    c.press({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 60 });
    c.press({ x: 12, y: 11, t: 180 }, { x: 12, y: 11, t: 240 });
    vi.advanceTimersByTime(2000);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('two slow presses are two clicks', () => {
    const { c, onClick, onDoubleClick } = make();
    c.press({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 60 });
    vi.advanceTimersByTime(600);
    c.press({ x: 10, y: 10, t: 700 }, { x: 10, y: 10, t: 760 });
    vi.advanceTimersByTime(600);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('a press that moves is a drag; a long hold is nothing', () => {
    const { c, onClick, onDrag } = make();
    c.press({ x: 10, y: 10, t: 0 }, { x: 40, y: 10, t: 300 });
    c.press({ x: 10, y: 10, t: 1000 }, { x: 10, y: 10, t: 3000 });
    vi.advanceTimersByTime(2000);
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('macOS: click then dblclick from AppKit is one double click', () => {
    const { c, onClick, onDoubleClick } = make();
    c.tap();
    vi.advanceTimersByTime(200);
    c.doubleTap();
    vi.advanceTimersByTime(2000);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses the OS interval once known, and dispose drops a pending click', () => {
    const { c, onClick } = make();
    c.setDoubleClickMs(300);
    c.tap();
    vi.advanceTimersByTime(300);
    expect(onClick).toHaveBeenCalledTimes(1);
    c.tap();
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
