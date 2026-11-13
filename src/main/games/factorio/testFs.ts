/** In-memory FactorioInstallDeps for the Factorio tests (no disk, any platform). */
import path from 'node:path';
import type { FactorioInstallDeps } from './install';

export interface MemFs {
  files: Map<string, string>;
  deps: FactorioInstallDeps;
}

export function memFs(
  platform: NodeJS.Platform,
  files: Record<string, string>,
  opts: { home?: string; env?: NodeJS.ProcessEnv; registry?: Partial<Record<'SteamPath' | 'SteamExe', string>>; running?: boolean | null } = {},
): MemFs {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x: string): string => p.normalize(x);
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const under = (dir: string): string[] => {
    const prefix = norm(dir).replace(/[\\/]+$/, '') + p.sep;
    return [...map.keys()].filter((k) => k.startsWith(prefix));
  };
  const deps: FactorioInstallDeps = {
    platform,
    home: opts.home ?? (platform === 'win32' ? 'C:\\Users\\you' : platform === 'darwin' ? '/Users/you' : '/home/you'),
    env: opts.env ?? (platform === 'win32' ? { APPDATA: 'C:\\Users\\you\\AppData\\Roaming', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' } : {}),
    exists: async (x) => map.has(norm(x)) || under(x).length > 0,
    readText: async (x) => map.get(norm(x)) ?? null,
    writeTextAtomic: async (x, text) => {
      map.set(norm(x), text);
    },
    copyDir: async (from, to) => {
      const prefix = norm(from) + p.sep;
      for (const [k, v] of [...map]) if (k.startsWith(prefix)) map.set(norm(p.join(to, ...k.slice(prefix.length).split(p.sep))), v);
    },
    remove: async (x) => {
      map.delete(norm(x));
      for (const k of under(x)) map.delete(k);
    },
    listDir: async (x) => {
      const prefix = norm(x).replace(/[\\/]+$/, '') + p.sep;
      const names = new Set<string>();
      for (const k of map.keys()) if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split(p.sep)[0]);
      return [...names];
    },
    registrySteam: async (v) => opts.registry?.[v] ?? null,
    gameRunning: async () => opts.running ?? false,
  };
  return { files: map, deps };
}
