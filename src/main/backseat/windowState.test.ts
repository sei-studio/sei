import { describe, expect, it } from 'vitest';
import { hwndOfSource, IS_ICONIC_SCRIPT } from './windowState';

describe('hwndOfSource', () => {
  it('reads the handle out of a Windows window source id', () => {
    expect(hwndOfSource('window:132456:0')).toBe('132456');
  });
  it('is null for screens and anything malformed', () => {
    expect(hwndOfSource('screen:0:0')).toBeNull();
    expect(hwndOfSource('window:abc:0')).toBeNull();
    expect(hwndOfSource('window:1; rm -rf:0')).toBeNull();
  });
  it('passes the handle by environment, never inside the script text', () => {
    expect(IS_ICONIC_SCRIPT).toContain('$env:SEI_HWND');
  });
});
