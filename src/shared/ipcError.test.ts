import { describe, it, expect } from 'vitest';
import { errorMessageOf, stripIpcWrapper, unwrapIpcRejection } from './ipcError';

const LIMIT = 'You can only have 4 companions. Remove one to make room.';

describe('stripIpcWrapper', () => {
  it('strips the Electron invoke wrapper and the Error prefix', () => {
    expect(stripIpcWrapper(`Error invoking remote method 'chars:add-to-library': Error: ${LIMIT}`)).toBe(LIMIT);
  });

  it('strips nested wrappers and repeated Error prefixes', () => {
    expect(
      stripIpcWrapper(
        `Error invoking remote method 'a:b': Error: Error invoking remote method 'c:d': Error: Error: ${LIMIT}`,
      ),
    ).toBe(LIMIT);
    expect(stripIpcWrapper(`Error: Error: ${LIMIT}`)).toBe(LIMIT);
  });

  it('strips any custom error class name', () => {
    expect(
      stripIpcWrapper("Error invoking remote method 'knowledge:extract': KnowledgeExtractError: That file is empty."),
    ).toBe('That file is empty.');
  });

  it("keeps JavaScript's own error classes so the renderer can recognise a bug", () => {
    expect(stripIpcWrapper("Error invoking remote method 'x:y': TypeError: a is not a function")).toBe(
      'TypeError: a is not a function',
    );
  });

  it('leaves an already clean message alone', () => {
    expect(stripIpcWrapper(LIMIT)).toBe(LIMIT);
    expect(stripIpcWrapper('SMAPI_INSTALL_FAILED: could not download')).toBe('SMAPI_INSTALL_FAILED: could not download');
    expect(stripIpcWrapper('')).toBe('');
  });
});

describe('errorMessageOf', () => {
  it('reads Errors, message objects and strings', () => {
    expect(errorMessageOf(new Error('boom'))).toBe('boom');
    expect(errorMessageOf({ message: 'from a result' })).toBe('from a result');
    expect(errorMessageOf('plain string')).toBe('plain string');
  });

  it('never yields "[object Object]", "undefined" or "null"', () => {
    expect(errorMessageOf(undefined)).toBe('');
    expect(errorMessageOf(null)).toBe('');
    expect(errorMessageOf({ code: 42 })).toBe('');
    expect(errorMessageOf({ message: undefined })).toBe('');
    expect(errorMessageOf(404)).toBe('404');
  });
});

describe('unwrapIpcRejection', () => {
  it('cleans an Error in place, keeping its identity', () => {
    const err = new Error(`Error invoking remote method 'chars:add-to-library': Error: ${LIMIT}`);
    const out = unwrapIpcRejection(err);
    expect(out).toBe(err);
    expect(out.message).toBe(LIMIT);
  });

  it('wraps a non-Error rejection in an Error', () => {
    const out = unwrapIpcRejection("Error invoking remote method 'x:y': Error: nope");
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe('nope');
    expect(unwrapIpcRejection(undefined).message).toBe('');
  });
});




