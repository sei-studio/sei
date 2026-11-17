import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUSTED_SIGN_SCRIPT, trustedSignFiles } from './winTrustedSign.mjs';

describe('trustedSignFiles', () => {
  it('runs one Invoke-TrustedSigning over a file list, values through the environment', () => {
    const calls = [];
    let listed = null;
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      listed = readFileSync(opts.env.SEI_SIGN_FILE_LIST, 'utf8');
      return { status: 0 };
    };
    trustedSignFiles(['C:\\p\\a.dll', 'C:\\p\\b.node'], {
      env: { AZURE_ENDPOINT: 'https://e', AZURE_CLIENT_SECRET: 's' },
      spawn,
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('pwsh');
    expect(calls[0].args).toContain('-EncodedCommand');
    // Secrets are never on the command line.
    expect(calls[0].args.join(' ')).not.toContain('https://e');
    expect(calls[0].opts.env.AZURE_CLIENT_SECRET).toBe('s');
    expect(listed).toBe('C:\\p\\a.dll\r\nC:\\p\\b.node\r\n');
    expect(existsSync(calls[0].opts.env.SEI_SIGN_FILE_LIST)).toBe(false); // cleaned up
    const decoded = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
    expect(decoded).toBe(TRUSTED_SIGN_SCRIPT);
    expect(decoded).toMatch(/-FileList \$env:SEI_SIGN_FILE_LIST/);
  });

  it('falls back to Windows PowerShell and throws on a failed run', () => {
    const cmds = [];
    const spawn = (cmd) => {
      cmds.push(cmd);
      return cmd === 'pwsh' ? { error: Object.assign(new Error('nope'), { code: 'ENOENT' }) } : { status: 1 };
    };
    expect(() => trustedSignFiles(['x.dll'], { env: {}, spawn, log: () => {} })).toThrow(/exited 1/);
    expect(cmds).toEqual(['pwsh', 'powershell.exe']);
  });

  it('does nothing for an empty list', () => {
    trustedSignFiles([], { spawn: () => { throw new Error('should not run'); } });
  });
});
