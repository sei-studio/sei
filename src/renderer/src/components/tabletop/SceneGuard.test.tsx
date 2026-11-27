/**
 * Review 615bff18 item 11: a 3D game whose WebGL scene cannot start, or loses
 * its context, shows one line and Close instead of taking the chat screen down.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../lib/ipcClient', () => ({ sei: {} }));

import { SceneBoundary, SceneFailedNotice, watchWebglContext } from './SceneGuard';

describe('SceneBoundary', () => {
  it('turns a thrown scene into the failed state and tells the panel once', () => {
    expect(SceneBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const onFail = vi.fn();
    const b = new SceneBoundary({ onFail, children: React.createElement('i', null, 'board') });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    b.componentDidCatch(new Error('Error creating WebGL context.'));
    err.mockRestore();
    expect(onFail).toHaveBeenCalledTimes(1);
    expect(b.render()).not.toBeNull();
    b.state = { failed: true };
    expect(b.render()).toBeNull();
  });
});

describe('watchWebglContext', () => {
  it('reports loss and restore from a canvas inside, and stops after unsubscribe', () => {
    const el = new EventTarget() as unknown as HTMLElement;
    const seen: boolean[] = [];
    const off = watchWebglContext(el, (lost) => seen.push(lost));
    el.dispatchEvent(new Event('webglcontextlost'));
    el.dispatchEvent(new Event('webglcontextrestored'));
    off();
    el.dispatchEvent(new Event('webglcontextlost'));
    expect(seen).toEqual([true, false]);
  });
});

describe('SceneFailedNotice', () => {
  it('is one line plus a Close button', () => {
    const html = renderToStaticMarkup(React.createElement(SceneFailedNotice, { onClose: () => undefined }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('3D board couldn&#x27;t load on this computer.');
    expect(html).toContain('Close');
    expect(html.match(/<p/g)).toHaveLength(1);
  });
});
