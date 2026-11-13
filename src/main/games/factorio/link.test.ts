import { describe, expect, it } from 'vitest';
import { LINK_PORT_RANGE, parseLinkRecord, pickLinkPort, portCandidates } from './link';

describe('the Sei link port', () => {
  it('parses defensively and never keeps the game port', () => {
    expect(parseLinkRecord(null)).toEqual({ port: null, bad: [] });
    expect(parseLinkRecord('{oops')).toEqual({ port: null, bad: [] });
    expect(parseLinkRecord(JSON.stringify({ port: 34197, bad: [34197, 34991, 'x'] }))).toEqual({ port: null, bad: [34991] });
    expect(parseLinkRecord(JSON.stringify({ port: 34995 }))).toEqual({ port: 34995, bad: [] });
  });

  it('tries the remembered port first, skips refused ones, resets when all are refused', () => {
    expect(LINK_PORT_RANGE[0]).toBe(34990);
    expect(LINK_PORT_RANGE).not.toContain(34197);
    expect(portCandidates({ port: 34993, bad: [] })[0]).toBe(34993);
    expect(portCandidates({ port: null, bad: [34990] })[0]).toBe(34991);
    expect(portCandidates({ port: null, bad: [...LINK_PORT_RANGE] })).toEqual([...LINK_PORT_RANGE]);
  });

  it('picks the first free port, or null', async () => {
    expect(await pickLinkPort({ port: null, bad: [] }, async (p) => p >= 34992)).toBe(34992);
    expect(await pickLinkPort({ port: null, bad: [] }, async () => false)).toBeNull();
    expect(await pickLinkPort({ port: null, bad: [] }, async () => { throw new Error('x'); })).toBeNull();
  });
});
