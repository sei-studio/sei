/**
 * 261029 review: App's 'loading' view used to be an empty fragment, a blank
 * window while the boot routing waited for main's auth state.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BootSplash } from './BootSplash';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('BootSplash', () => {
  it('renders a visible loading state with the Sei mark', () => {
    const html = renderToStaticMarkup(React.createElement(BootSplash));
    expect(html).toContain('data-boot-splash');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="img"');
    expect(html).toContain('sei-text.png');
  });
  it("is what App renders for the 'loading' view", () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8');
    expect(app).toContain("if (view.kind === 'loading') return <BootSplash />;");
    expect(app).not.toContain("if (view.kind === 'loading') return <></>;");
  });
  it('the scope-changed handler leaves routing to the boot while loading', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf-8');
    const handler = app.slice(app.indexOf('return sei.onScopeChanged((ev) => {'));
    const loadingGuard = handler.indexOf("if (useUiStore.getState().view.kind === 'loading') {");
    const firstNavigate = handler.indexOf('navigate(');
    expect(loadingGuard).toBeGreaterThan(0);
    expect(loadingGuard).toBeLessThan(firstNavigate);
  });
});
